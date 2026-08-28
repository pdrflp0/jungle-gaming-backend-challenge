import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, PurgeQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import config from '../../mikro-orm.config';
import { OpenWalletUseCase } from '../wallets/open-wallet.use-case';
import { processWagerTransactionMessage } from './process-wager-transaction-message';
import { createSqsClient, resolveQueueUrl, WAGER_TRANSACTIONS_QUEUE_NAME } from './sqs-client';
import { buildWagerTransactionMessageBody, sendTestMessage, waitFor } from './sqs-test-helpers';
import { WagerTransactionSqsConsumer } from './wager-transaction-sqs-consumer';

/**
 * Integracao real do consumidor SQS (Bloco 9b.2): LocalStack real +
 * PostgreSQL real, ponta a ponta. O nucleo transacional (Inbox, caso de
 * uso, Outbox, atomicidade) ja foi provado no Bloco 9b.1 sem nenhum SQS —
 * aqui a pergunta e so "o loop de ReceiveMessage/DeleteMessage se comporta
 * certo em cima disso".
 *
 * `WAGER_TRANSACTIONS_CONSUMER_ENABLED` e ligado SO neste arquivo (beforeAll)
 * e desligado no final (afterAll) — nenhum outro teste do projeto deve
 * herdar isso nem precisar do LocalStack no ar.
 *
 * Sem sufixo .spec./.test. de proposito — roda so via `bun run test:integration`.
 */

const WAGER_TRANSACTIONS_DLQ_NAME = 'wager-transactions-dlq.fifo';

let orm: MikroORM;
let sendClient: SQSClient;
let queueUrl: string;
let dlqUrl: string;

beforeAll(async () => {
  orm = await MikroORM.init(config);
  process.env.WAGER_TRANSACTIONS_CONSUMER_ENABLED = 'true';
  // So neste arquivo: encurta o long-poll vazio para nao pagar ate 20s reais
  // de espera toda vez que um teste para o consumidor sem nenhuma mensagem
  // em voo. Producao continua com os 20s completos (variavel nao setada la).
  process.env.WAGER_TRANSACTIONS_SQS_WAIT_TIME_SECONDS = '2';
  sendClient = createSqsClient();
  queueUrl = await resolveQueueUrl(sendClient, WAGER_TRANSACTIONS_QUEUE_NAME);
  dlqUrl = await resolveQueueUrl(sendClient, WAGER_TRANSACTIONS_DLQ_NAME);
  // Garante um ponto de partida limpo, independente do que sobrou de uma
  // execucao anterior interrompida — nao altera nenhum atributo da fila,
  // so esvazia mensagens.
  await sendClient.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
  await sendClient.send(new PurgeQueueCommand({ QueueUrl: dlqUrl }));
});

afterEach(async () => {
  await orm.em
    .getConnection()
    .execute('TRUNCATE TABLE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets');
  // Alguns testes deixam de proposito uma mensagem que nunca deveria ser
  // apagada (payload invalido, conflito, wallet inexistente) — sem isto,
  // ela sobreviveria para o proximo teste e corromperia qualquer asserção
  // de "fila vazia" que nao seja deste teste especifico.
  await sendClient.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
});

afterAll(async () => {
  delete process.env.WAGER_TRANSACTIONS_CONSUMER_ENABLED;
  delete process.env.WAGER_TRANSACTIONS_SQS_WAIT_TIME_SECONDS;
  sendClient.destroy();
  await orm.close();
});

async function createWallet(initialAmount: string): Promise<{ walletId: string; playerId: string }> {
  const em = orm.em.fork();
  const playerId = randomUUID();
  const useCase = new OpenWalletUseCase(em);
  const result = await useCase.execute(
    { playerId, initialBalance: { amount: initialAmount, currency: 'BRL' } },
    randomUUID(),
  );
  return { walletId: result.id, playerId };
}

async function startConsumer(): Promise<WagerTransactionSqsConsumer> {
  const consumer = new WagerTransactionSqsConsumer(orm.em.fork());
  await consumer.onModuleInit();
  return consumer;
}

async function stopConsumer(consumer: WagerTransactionSqsConsumer): Promise<void> {
  await consumer.onApplicationShutdown();
}

async function walletBalance(walletId: string): Promise<string> {
  const rows = await orm.em
    .getConnection()
    .execute<{ balance_amount: string }[]>('SELECT balance_amount FROM wallets WHERE id = ?', [walletId]);
  return rows[0].balance_amount;
}

async function wagerTransactionRow(providerId: string, externalTransactionId: string) {
  const rows = await orm.em
    .getConnection()
    .execute<Array<{ id: string; status: string; failure_code: string | null }>>(
      'SELECT id, status, failure_code FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?',
      [providerId, externalTransactionId],
    );
  return rows[0];
}

async function countAll(table: string): Promise<number> {
  const rows = await orm.em.getConnection().execute<{ count: number }[]>(`SELECT count(*)::int AS count FROM ${table}`);
  return rows[0].count;
}

/**
 * `ApproximateNumberOfMessages` sozinho NAO basta para provar "a mensagem
 * foi apagada": uma mensagem em voo (recebida, ainda dentro do visibility
 * timeout, nao apagada) fica INVISIVEL, mas continua existindo — apareceria
 * como zero num ReceiveMessage mesmo sem ter sido deletada. Por isso soma-se
 * tambem `ApproximateNumberOfMessagesNotVisible`: só quando os dois chegam a
 * zero e que a mensagem realmente nao existe mais na fila.
 */
async function totalQueueMessageCount(): Promise<number> {
  const { Attributes } = await sendClient.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  const visible = Number(Attributes?.ApproximateNumberOfMessages ?? '0');
  const inFlight = Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0');
  return visible + inFlight;
}

async function dlqMessageCount(): Promise<number> {
  const { Attributes } = await sendClient.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['ApproximateNumberOfMessages'] }),
  );
  return Number(Attributes?.ApproximateNumberOfMessages ?? '0');
}

describe('WagerTransactionSqsConsumer — sucesso (Bloco 9b.2)', () => {
  test('mensagem valida: efeito financeiro correto e mensagem removida so depois do commit', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const externalTransactionId = randomUUID();
    const body = buildWagerTransactionMessageBody(walletId, playerId, { dataOverrides: { externalTransactionId } });

    // Envia ANTES de iniciar o consumidor: garante que a mensagem ja esta
    // na fila quando o primeiro ReceiveMessage acontecer, sem depender de
    // o long-poll "acordar" no meio de uma espera ja em andamento.
    await sendTestMessage(sendClient, queueUrl, body, { messageGroupId: walletId, messageDeduplicationId: randomUUID() });

    const consumer = await startConsumer();
    try {
      await waitFor(
        async () => {
          const tx = await wagerTransactionRow('provider-a', externalTransactionId);
          return tx?.status === 'PROCESSED';
        },
        { description: 'wager transaction PROCESSED' },
      );

      expect(await walletBalance(walletId)).toBe('75.00');
      await waitFor(async () => (await totalQueueMessageCount()) === 0, { description: 'fila vazia (mensagem apagada)' });
    } finally {
      await stopConsumer(consumer);
    }
  }, 15_000);

  test('rejeicao de negocio: estado REJECTED persistido e mensagem removida', async () => {
    const { walletId, playerId } = await createWallet('10.00');
    const externalTransactionId = randomUUID();
    const body = buildWagerTransactionMessageBody(walletId, playerId, {
      dataOverrides: { externalTransactionId, money: { amount: '25.00', currency: 'BRL' } },
    });

    await sendTestMessage(sendClient, queueUrl, body, { messageGroupId: walletId, messageDeduplicationId: randomUUID() });

    const consumer = await startConsumer();
    try {
      await waitFor(
        async () => {
          const tx = await wagerTransactionRow('provider-a', externalTransactionId);
          return tx?.status === 'REJECTED';
        },
        { description: 'wager transaction REJECTED' },
      );

      const tx = await wagerTransactionRow('provider-a', externalTransactionId);
      expect(tx.failure_code).toBe('INSUFFICIENT_FUNDS');
      await waitFor(async () => (await totalQueueMessageCount()) === 0, { description: 'fila vazia (rejeicao tambem apaga)' });
    } finally {
      await stopConsumer(consumer);
    }
  }, 15_000);
});

describe('WagerTransactionSqsConsumer — duplicata e conflito (Bloco 9b.2)', () => {
  test('mesma messageId reentregue (dedup id de transporte diferente): duplicate, sem segundo efeito', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const messageId = randomUUID();
    const externalTransactionId = randomUUID();
    const body = buildWagerTransactionMessageBody(walletId, playerId, { messageId, dataOverrides: { externalTransactionId } });

    await sendTestMessage(sendClient, queueUrl, body, { messageGroupId: walletId, messageDeduplicationId: randomUUID() });

    const consumer = await startConsumer();
    try {
      await waitFor(async () => (await wagerTransactionRow('provider-a', externalTransactionId))?.status === 'PROCESSED', {
        description: 'primeira entrega processada',
      });

      const balanceAfterFirst = await walletBalance(walletId);
      const outboxCountAfterFirst = await countAll('outbox_messages');

      // mesmo messageId de NEGOCIO, mas um MessageDeduplicationId de
      // TRANSPORTE diferente — simula um reenvio genuino que o SQS nao
      // deduplicaria sozinho. E o Inbox, nao o SQS, quem precisa pegar isto.
      await sendTestMessage(sendClient, queueUrl, body, { messageGroupId: walletId, messageDeduplicationId: randomUUID() });

      await waitFor(async () => (await totalQueueMessageCount()) === 0, {
        description: 'segunda entrega tambem e apagada (duplicate)',
      });

      expect(await walletBalance(walletId)).toBe(balanceAfterFirst);
      expect(await countAll('outbox_messages')).toBe(outboxCountAfterFirst);
    } finally {
      await stopConsumer(consumer);
    }
  }, 15_000);

  test('mesma messageId, payload diferente: conflito, mensagem NAO e removida', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const messageId = randomUUID();
    const externalTransactionId = randomUUID();
    const first = buildWagerTransactionMessageBody(walletId, playerId, { messageId, dataOverrides: { externalTransactionId } });

    await sendTestMessage(sendClient, queueUrl, first, { messageGroupId: walletId, messageDeduplicationId: randomUUID() });

    const consumer = await startConsumer();
    try {
      await waitFor(async () => (await wagerTransactionRow('provider-a', externalTransactionId))?.status === 'PROCESSED', {
        description: 'primeira entrega processada',
      });

      const balanceAfterFirst = await walletBalance(walletId);

      const conflicting = buildWagerTransactionMessageBody(walletId, playerId, {
        messageId,
        dataOverrides: { externalTransactionId, money: { amount: '30.00', currency: 'BRL' } },
      });
      await sendTestMessage(sendClient, queueUrl, conflicting, { messageGroupId: walletId, messageDeduplicationId: randomUUID() });

      // da tempo do consumidor tentar e falhar — como ele NAO apaga em
      // conflito, a mensagem continua na fila (visivel ou em voo dentro do
      // visibility timeout, mas nunca removida de verdade). Confirmamos que
      // nao houve novo efeito financeiro.
      await waitFor(async () => (await totalQueueMessageCount()) >= 1, { description: 'segunda mensagem chegou a fila', timeoutMs: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(await walletBalance(walletId)).toBe(balanceAfterFirst);
      expect(await totalQueueMessageCount()).toBeGreaterThanOrEqual(1);
    } finally {
      await stopConsumer(consumer);
    }
  }, 15_000);
});

describe('WagerTransactionSqsConsumer — payload invalido (Bloco 9b.2)', () => {
  test('JSON invalido: nao e removido da fila', async () => {
    await sendTestMessage(sendClient, queueUrl, '{ this is not valid json', {
      messageGroupId: randomUUID(),
      messageDeduplicationId: randomUUID(),
    });

    const consumer = await startConsumer();
    try {
      // espera o consumidor tentar e desistir sem apagar
      await waitFor(async () => (await totalQueueMessageCount()) >= 1, { description: 'mensagem chegou a fila', timeoutMs: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(await totalQueueMessageCount()).toBeGreaterThanOrEqual(1);
    } finally {
      await stopConsumer(consumer);
    }
  }, 15_000);
});

describe('WagerTransactionSqsConsumer — erro que impede o commit (Bloco 9b.2)', () => {
  test('wallet inexistente: transacao inteira desfeita, mensagem NAO removida', async () => {
    // Representa a categoria "erro durante o processamento -> rollback
    // completo -> sem delete". Um lock-wait-timeout/deadlock genuino nao e
    // reproduzivel neste sistema sem alterar configuracao de conexao de um
    // bloco anterior (nenhum lock_timeout esta configurado, e nenhum fluxo
    // trava duas wallets na mesma transacao) — isso fica documentado
    // explicitamente no relatorio final, nao escondido.
    const nonExistentWalletId = randomUUID();
    const body = buildWagerTransactionMessageBody(nonExistentWalletId, randomUUID());

    await sendTestMessage(sendClient, queueUrl, body, {
      messageGroupId: nonExistentWalletId,
      messageDeduplicationId: randomUUID(),
    });

    const consumer = await startConsumer();
    try {
      await waitFor(async () => (await totalQueueMessageCount()) >= 1, { description: 'mensagem chegou a fila', timeoutMs: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(await totalQueueMessageCount()).toBeGreaterThanOrEqual(1);
      expect(await countAll('inbox_messages')).toBe(0);
      expect(await countAll('wager_transactions')).toBe(0);
    } finally {
      await stopConsumer(consumer);
    }
  }, 15_000);
});

describe('WagerTransactionSqsConsumer — falha equivalente a DeleteMessage (Bloco 9b.2)', () => {
  test('efeito ja commitado sem nunca ter sido apagado: reentrega nao duplica', async () => {
    // Simula exatamente a janela "commit ja aconteceu, mas o DeleteMessage
    // nunca chegou a acontecer" (crash de processo, falha de rede no
    // DeleteMessage — o efeito no sistema e identico nos dois casos):
    // processamos a mensagem diretamente pelo nucleo do 9b.1, SEM passar
    // pelo consumidor, entao nenhum DeleteMessage e chamado — a mensagem
    // continua na fila, ja totalmente processada.
    const { walletId, playerId } = await createWallet('100.00');
    const externalTransactionId = randomUUID();
    const body = buildWagerTransactionMessageBody(walletId, playerId, { dataOverrides: { externalTransactionId } });

    await sendTestMessage(sendClient, queueUrl, body, { messageGroupId: walletId, messageDeduplicationId: randomUUID() });

    const em = orm.em.fork();
    const result = await em.transactional((trxEm) => processWagerTransactionMessage(trxEm, body));
    expect(result).toBe('processed');

    const balanceAfterCommit = await walletBalance(walletId);
    const outboxCountAfterCommit = await countAll('outbox_messages');

    // agora o consumidor de verdade recebe a MESMA mensagem (nunca foi
    // apagada) e deve reconhecer via Inbox que ja foi processada.
    const consumer = await startConsumer();
    try {
      await waitFor(async () => (await totalQueueMessageCount()) === 0, {
        description: 'consumidor recebe, reconhece duplicate, apaga',
      });

      expect(await walletBalance(walletId)).toBe(balanceAfterCommit);
      expect(await countAll('outbox_messages')).toBe(outboxCountAfterCommit);
    } finally {
      await stopConsumer(consumer);
    }
  }, 15_000);
});

describe('WagerTransactionSqsConsumer — shutdown gracioso (Bloco 9b.2)', () => {
  test('mensagem em andamento termina normalmente, sem perda', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const externalTransactionId = randomUUID();
    const body = buildWagerTransactionMessageBody(walletId, playerId, { dataOverrides: { externalTransactionId } });

    await sendTestMessage(sendClient, queueUrl, body, { messageGroupId: walletId, messageDeduplicationId: randomUUID() });
    const consumer = await startConsumer();

    // dispara o shutdown quase junto com o inicio — onApplicationShutdown so
    // pode retornar depois que a iteracao de processamento em andamento
    // (se houver) tiver terminado de verdade.
    await stopConsumer(consumer);

    const tx = await wagerTransactionRow('provider-a', externalTransactionId);
    if (tx) {
      // ou o shutdown pegou a mensagem a tempo de processa-la...
      expect(tx.status).toBe('PROCESSED');
      expect(await walletBalance(walletId)).toBe('75.00');
    } else {
      // ...ou nao chegou a receber nada ainda, e a mensagem continua
      // intacta na fila para uma proxima instancia processar — de qualquer
      // forma, nunca perdida nem meio-processada.
      expect(await totalQueueMessageCount()).toBeGreaterThanOrEqual(1);
    }
  }, 15_000);
});

describe('WagerTransactionSqsConsumer — esgotamento de tentativas (Bloco 9b.2)', () => {
  test(
    'mensagem que sempre falha chega em wager-transactions-dlq.fifo apos maxReceiveCount=5',
    async () => {
      // Nenhum codigo nosso move a mensagem para a DLQ — isto e inteiramente
      // o RedrivePolicy da fila (Bloco 9a.3, nao alterado aqui) fazendo seu
      // trabalho depois de 5 entregas fracassadas. O teste so espera o tempo
      // real necessario (ate ~5 x 30s de visibility timeout) — deliberadamente
      // sem tentar acelerar via ChangeMessageVisibility, para nao arriscar
      // interferir com o proprio ciclo de recebimento do consumidor.
      const nonExistentWalletId = randomUUID();
      const body = buildWagerTransactionMessageBody(nonExistentWalletId, randomUUID());

      const consumer = await startConsumer();
      try {
        await sendTestMessage(sendClient, queueUrl, body, {
          messageGroupId: nonExistentWalletId,
          messageDeduplicationId: randomUUID(),
        });

        await waitFor(async () => (await dlqMessageCount()) >= 1, {
          timeoutMs: 200_000,
          intervalMs: 2000,
          description: 'mensagem chega na DLQ apos esgotar as tentativas',
        });

        expect(await countAll('wager_transactions')).toBe(0);
      } finally {
        await stopConsumer(consumer);
      }
    },
    210_000,
  );
});

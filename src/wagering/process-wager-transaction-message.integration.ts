import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../mikro-orm.config';
import { OpenWalletUseCase } from '../wallets/open-wallet.use-case';
import { computePayloadHash, WagerTransactionPayload } from './payload-hash';
import {
  ConflictingInboxPayloadError,
  InconsistentInboxStateError,
  InvalidWagerTransactionMessageError,
  processWagerTransactionMessage,
  WAGER_TRANSACTIONS_CONSUMER_NAME,
} from './process-wager-transaction-message';

/**
 * Integracao real do nucleo transacional do consumidor SQS (Bloco 9b.1),
 * contra PostgreSQL — sem nenhuma linha de codigo de SQS. Cada chamada a
 * `processWagerTransactionMessage` roda dentro de um `em.transactional()`
 * proprio do teste, exatamente como o futuro consumidor (Bloco 9b.2) vai
 * fazer — a funcao nucleo nunca abre a sua propria transacao.
 *
 * Sem sufixo .spec./.test. de proposito — roda so via `bun run test:integration`.
 */

let orm: MikroORM;

beforeAll(async () => {
  orm = await MikroORM.init(config);
});

afterEach(async () => {
  await orm.em
    .getConnection()
    .execute('TRUNCATE TABLE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets');
});

afterAll(async () => {
  await orm.close();
});

async function process(rawBody: string) {
  const em = orm.em.fork();
  return em.transactional((trxEm) => processWagerTransactionMessage(trxEm, rawBody));
}

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

interface EnvelopeOptions {
  messageId?: string;
  dataOverrides?: Record<string, unknown>;
}

function buildEnvelope(walletId: string, playerId: string, options: EnvelopeOptions = {}): string {
  const data = {
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...options.dataOverrides,
  };

  return JSON.stringify({
    messageId: options.messageId ?? randomUUID(),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data,
  });
}

async function walletBalance(walletId: string): Promise<string> {
  const rows = await orm.em
    .getConnection()
    .execute<{ balance_amount: string }[]>('SELECT balance_amount FROM wallets WHERE id = ?', [walletId]);
  return rows[0].balance_amount;
}

async function countAll(table: string): Promise<number> {
  const rows = await orm.em.getConnection().execute<{ count: number }[]>(`SELECT count(*)::int AS count FROM ${table}`);
  return rows[0].count;
}

async function inboxRow(messageId: string) {
  const rows = await orm.em
    .getConnection()
    .execute<{ payload_hash: string; processed_at: Date | null }[]>(
      'SELECT payload_hash, processed_at FROM inbox_messages WHERE consumer_name = ? AND message_id = ?',
      [WAGER_TRANSACTIONS_CONSUMER_NAME, messageId],
    );
  return rows[0];
}

async function wagerTransactionRow(providerId: string, externalTransactionId: string) {
  const rows = await orm.em
    .getConnection()
    .execute<Array<{ id: string; status: string; failure_code: string | null; correlation_id: string; pending_reference_event_id: string | null }>>(
      'SELECT id, status, failure_code, correlation_id, pending_reference_event_id FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?',
      [providerId, externalTransactionId],
    );
  return rows[0];
}

async function outboxEventTypesFor(aggregateId: string): Promise<string[]> {
  const rows = await orm.em
    .getConnection()
    .execute<{ event_type: string }[]>('SELECT event_type FROM outbox_messages WHERE aggregate_id = ? ORDER BY occurred_at, id', [
      aggregateId,
    ]);
  return rows.map((row) => row.event_type);
}

describe('processWagerTransactionMessage — sucesso basico', () => {
  test('BET valido: processa, credita/debita corretamente, Inbox marcado processado com correlationId = messageId', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const messageId = randomUUID();
    const externalTransactionId = randomUUID();
    const envelope = buildEnvelope(walletId, playerId, { messageId, dataOverrides: { externalTransactionId } });

    const result = await process(envelope);
    expect(result).toBe('processed');

    expect(await walletBalance(walletId)).toBe('75.00');

    const tx = await wagerTransactionRow('provider-a', externalTransactionId);
    expect(tx.status).toBe('PROCESSED');
    expect(tx.correlation_id).toBe(messageId);

    const inbox = await inboxRow(messageId);
    expect(inbox.payload_hash).toBeTruthy();
    expect(inbox.processed_at).not.toBeNull();

    const txEvents = await outboxEventTypesFor(tx.id);
    expect(txEvents).toEqual(['WagerTransactionProcessed']);
  });

  test('todos os kinds nao-internos sao aceitos (WIN, LOSS, REFUND, ROLLBACK)', async () => {
    const { walletId, playerId } = await createWallet('1000.00');
    const betExternalId = randomUUID();
    await process(buildEnvelope(walletId, playerId, { dataOverrides: { externalTransactionId: betExternalId, kind: 'BET' } }));

    const winResult = await process(
      buildEnvelope(walletId, playerId, {
        dataOverrides: {
          externalTransactionId: randomUUID(),
          kind: 'WIN',
          money: { amount: '10.00', currency: 'BRL' },
          referenceExternalTransactionId: betExternalId,
        },
      }),
    );
    expect(winResult).toBe('processed');

    const lossResult = await process(buildEnvelope(walletId, playerId, { dataOverrides: { externalTransactionId: randomUUID(), kind: 'LOSS' } }));
    expect(lossResult).toBe('processed');

    const refundExternalId = randomUUID();
    const refundResult = await process(
      buildEnvelope(walletId, playerId, {
        dataOverrides: {
          externalTransactionId: refundExternalId,
          kind: 'REFUND',
          money: { amount: '25.00', currency: 'BRL' },
          referenceExternalTransactionId: betExternalId,
        },
      }),
    );
    expect(refundResult).toBe('processed');

    const rollbackResult = await process(
      buildEnvelope(walletId, playerId, {
        dataOverrides: {
          externalTransactionId: randomUUID(),
          kind: 'ROLLBACK',
          money: { amount: '10.00', currency: 'BRL' },
          referenceExternalTransactionId: refundExternalId,
        },
      }),
    );
    expect(rollbackResult).toBe('processed');
  });
});

describe('processWagerTransactionMessage — replay e duplicata verdadeira', () => {
  test('mesma messageId e mesmo payload: segunda chamada retorna duplicate, sem novo efeito', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const messageId = randomUUID();
    const externalTransactionId = randomUUID();
    const envelope = buildEnvelope(walletId, playerId, { messageId, dataOverrides: { externalTransactionId } });

    const first = await process(envelope);
    expect(first).toBe('processed');

    const balanceAfterFirst = await walletBalance(walletId);
    const ledgerCountAfterFirst = await countAll('wallet_ledger_entries');
    const outboxCountAfterFirst = await countAll('outbox_messages');

    const second = await process(envelope); // exatamente o mesmo corpo
    expect(second).toBe('duplicate');

    expect(await walletBalance(walletId)).toBe(balanceAfterFirst);
    expect(await countAll('wallet_ledger_entries')).toBe(ledgerCountAfterFirst);
    expect(await countAll('outbox_messages')).toBe(outboxCountAfterFirst);
  });
});

describe('processWagerTransactionMessage — conflito de payload (poison message)', () => {
  test('mesma messageId, payload diferente: lanca ConflictingInboxPayloadError, sem novo efeito', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const messageId = randomUUID();
    const externalTransactionId = randomUUID();
    const envelope = buildEnvelope(walletId, playerId, { messageId, dataOverrides: { externalTransactionId } });

    const first = await process(envelope);
    expect(first).toBe('processed');

    const balanceAfterFirst = await walletBalance(walletId);
    const outboxCountAfterFirst = await countAll('outbox_messages');

    const conflicting = buildEnvelope(walletId, playerId, {
      messageId, // mesma messageId
      dataOverrides: { externalTransactionId, money: { amount: '30.00', currency: 'BRL' } }, // payload diferente
    });

    await expect(process(conflicting)).rejects.toThrow(ConflictingInboxPayloadError);

    expect(await walletBalance(walletId)).toBe(balanceAfterFirst);
    expect(await countAll('outbox_messages')).toBe(outboxCountAfterFirst);
  });
});

describe('processWagerTransactionMessage — estado inconsistente do Inbox', () => {
  test('linha do Inbox existente com processedAt NULL: lanca InconsistentInboxStateError, nunca ACK silencioso', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const messageId = randomUUID();
    const externalTransactionId = randomUUID();
    const envelope = buildEnvelope(walletId, playerId, { messageId, dataOverrides: { externalTransactionId } });

    // simula o estado anormal diretamente: uma linha "reivindicada" mas
    // nunca marcada como processada — isso nao deveria acontecer no fluxo
    // normal (Inbox e o efeito financeiro sempre commitam juntos).
    const parsed = JSON.parse(envelope) as { data: WagerTransactionPayload };
    const payloadHash = computePayloadHash(parsed.data);
    await orm.em
      .getConnection()
      .execute('INSERT INTO inbox_messages (message_id, consumer_name, payload_hash, received_at) VALUES (?, ?, ?, now())', [
        messageId,
        WAGER_TRANSACTIONS_CONSUMER_NAME,
        payloadHash,
      ]);

    await expect(process(envelope)).rejects.toThrow(InconsistentInboxStateError);

    // nada financeiro foi criado por essa tentativa
    expect(await countAll('wager_transactions')).toBe(1); // so a OPENING da wallet
  });
});

describe('processWagerTransactionMessage — payload invalido', () => {
  async function expectNoWrite(rawBody: string) {
    const before = {
      inbox: await countAll('inbox_messages'),
      wagerTransactions: await countAll('wager_transactions'),
      outbox: await countAll('outbox_messages'),
    };

    await expect(process(rawBody)).rejects.toThrow(InvalidWagerTransactionMessageError);

    expect(await countAll('inbox_messages')).toBe(before.inbox);
    expect(await countAll('wager_transactions')).toBe(before.wagerTransactions);
    expect(await countAll('outbox_messages')).toBe(before.outbox);
  }

  test('JSON malformado', async () => {
    await expectNoWrite('{ this is not valid json');
  });

  test('type diferente de WagerTransactionRequested', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const parsed = JSON.parse(buildEnvelope(walletId, playerId));
    parsed.type = 'SomethingElse';
    await expectNoWrite(JSON.stringify(parsed));
  });

  test('campo obrigatorio faltando em data (kind ausente)', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const parsed = JSON.parse(buildEnvelope(walletId, playerId));
    delete parsed.data.kind;
    await expectNoWrite(JSON.stringify(parsed));
  });

  test('campo extra nao esperado (forbidNonWhitelisted)', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const parsed = JSON.parse(buildEnvelope(walletId, playerId));
    parsed.data.somethingUnexpected = 'nope';
    await expectNoWrite(JSON.stringify(parsed));
  });

  test('kind OPENING nao e aceito pela fila (interno, nunca externo)', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    await expectNoWrite(buildEnvelope(walletId, playerId, { dataOverrides: { kind: 'OPENING' } }));
  });
});

describe('processWagerTransactionMessage — rejeicao de negocio e PENDING_REFERENCE', () => {
  test('BET acima do saldo: retorna processed, WagerTransaction REJECTED, Inbox processado, Outbox com Rejected', async () => {
    const { walletId, playerId } = await createWallet('10.00');
    const externalTransactionId = randomUUID();
    const messageId = randomUUID();
    const envelope = buildEnvelope(walletId, playerId, {
      messageId,
      dataOverrides: { externalTransactionId, money: { amount: '25.00', currency: 'BRL' } },
    });

    const result = await process(envelope);
    expect(result).toBe('processed');

    const tx = await wagerTransactionRow('provider-a', externalTransactionId);
    expect(tx.status).toBe('REJECTED');
    expect(tx.failure_code).toBe('INSUFFICIENT_FUNDS');

    const inbox = await inboxRow(messageId);
    expect(inbox.processed_at).not.toBeNull();

    expect(await outboxEventTypesFor(tx.id)).toEqual(['WagerTransactionRejected']);
  });

  test('REFUND referenciando algo inexistente: retorna processed, PENDING_REFERENCE persistido, pending_reference_event_id gravado', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const externalTransactionId = randomUUID();
    const messageId = randomUUID();
    const envelope = buildEnvelope(walletId, playerId, {
      messageId,
      dataOverrides: {
        externalTransactionId,
        kind: 'REFUND',
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: randomUUID(),
      },
    });

    const result = await process(envelope);
    expect(result).toBe('processed');

    const tx = await wagerTransactionRow('provider-a', externalTransactionId);
    expect(tx.status).toBe('PENDING_REFERENCE');
    expect(tx.pending_reference_event_id).not.toBeNull();

    expect(await outboxEventTypesFor(tx.id)).toEqual(['WagerTransactionPendingReference']);
  });
});

describe('processWagerTransactionMessage — atomicidade', () => {
  test('erro forcado depois da funcao central retornar desfaz Inbox, wallet, WagerTransaction, ledger e Outbox juntos', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const externalTransactionId = randomUUID();
    const envelope = buildEnvelope(walletId, playerId, { dataOverrides: { externalTransactionId } });

    class ForcedRollback extends Error {}

    const em = orm.em.fork();
    await expect(
      em.transactional(async (trxEm) => {
        const result = await processWagerTransactionMessage(trxEm, envelope);
        expect(result).toBe('processed');
        throw new ForcedRollback('forced before external commit');
      }),
    ).rejects.toThrow(ForcedRollback);

    expect(await walletBalance(walletId)).toBe('100.00'); // BET nao aplicada
    expect(await countAll('wager_transactions')).toBe(1); // so a OPENING
    expect(await countAll('wallet_ledger_entries')).toBe(1); // so a OPENING
    expect(await countAll('inbox_messages')).toBe(0);
    expect(await countAll('outbox_messages')).toBe(2); // so Processed+WalletBalanceChanged da OPENING
  });
});

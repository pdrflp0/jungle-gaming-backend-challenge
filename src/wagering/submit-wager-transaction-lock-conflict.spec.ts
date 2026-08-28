import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { DeadlockException, LockWaitTimeoutException } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { metricsRegistry } from '../observability/metrics';
import type { SubmitWagerTransactionDto } from './dto/submit-wager-transaction.dto';
import { SubmitWagerTransactionUseCase } from './submit-wager-transaction.use-case';

/**
 * CHALLENGE.md secao 12 exige uma metrica de "conflitos de lock". O UNICO
 * lugar do projeto inteiro que ja captura DeadlockException/
 * LockWaitTimeoutException e o catch de SubmitWagerTransactionUseCase.execute()
 * (ver submit-wager-transaction.use-case.ts) — mas um deadlock ou
 * lock-wait-timeout GENUINO nao e reproduzivel neste sistema sem alterar
 * configuracao de conexao (nenhum `lock_timeout` esta configurado no Postgres)
 * ou sem um fluxo que trave mais de uma wallet na mesma transacao (nao existe
 * nenhum — cada transacao financeira trava exatamente UMA wallet, sempre
 * primeiro). Essa limitacao ja foi documentada explicitamente desde o Bloco
 * 9b.2 (ver o comentario em wager-transaction-sqs-consumer.integration.ts,
 * describe "erro que impede o commit").
 *
 * Este teste prova que o CODIGO REAL do catch — as classes reais de
 * excecao do MikroORM, o `if` real, o `.inc()` real — incrementa a metrica
 * corretamente quando essas excecoes acontecem. Ele NAO prova (nem finge
 * provar) que algum cenario de concorrencia real deste sistema hoje dispara
 * essas excecoes, porque nenhum dispara. So o `EntityManager.transactional`
 * e substituido por um fake que rejeita direto com a excecao real — mesmo
 * padrao ja usado em health.integration.ts para os ramos de falha.
 */
function buildRejectingEntityManager(error: Error): EntityManager {
  return {
    getConnection: () => ({ execute: () => Promise.resolve([]) }),
    getTransactionContext: () => undefined,
    transactional: () => Promise.reject(error),
  } as unknown as EntityManager;
}

function buildDto(): SubmitWagerTransactionDto {
  return {
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    playerId: randomUUID(),
    walletId: randomUUID(),
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
  } as SubmitWagerTransactionDto;
}

async function conflictCount(type: 'deadlock' | 'lock_timeout'): Promise<number> {
  const metric = await metricsRegistry.getSingleMetric('wager_lock_conflicts_total')?.get();
  return metric?.values.find((v) => v.labels.type === type)?.value ?? 0;
}

describe('SubmitWagerTransactionUseCase — metrica de conflito de lock (limitacao documentada, ver comentario acima)', () => {
  test('DeadlockException real do MikroORM: incrementa wager_lock_conflicts_total{type="deadlock"} e devolve 503', async () => {
    const before = await conflictCount('deadlock');
    const useCase = new SubmitWagerTransactionUseCase(
      buildRejectingEntityManager(new DeadlockException(new Error('deadlock detected'))),
    );

    await expect(useCase.execute(randomUUID(), buildDto(), randomUUID())).rejects.toThrow(
      'Temporary database contention, please retry',
    );

    expect(await conflictCount('deadlock')).toBe(before + 1);
  });

  test('LockWaitTimeoutException real do MikroORM: incrementa wager_lock_conflicts_total{type="lock_timeout"} e devolve 503', async () => {
    const before = await conflictCount('lock_timeout');
    const useCase = new SubmitWagerTransactionUseCase(
      buildRejectingEntityManager(new LockWaitTimeoutException(new Error('lock wait timeout'))),
    );

    await expect(useCase.execute(randomUUID(), buildDto(), randomUUID())).rejects.toThrow(
      'Temporary database contention, please retry',
    );

    expect(await conflictCount('lock_timeout')).toBe(before + 1);
  });
});

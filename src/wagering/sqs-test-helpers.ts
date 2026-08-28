import { randomUUID } from 'node:crypto';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

/**
 * So para testes deste bloco (9b.2) — nunca usado por codigo de producao.
 * Nao antecipa o publisher da Outbox (Bloco 9c): e so infraestrutura para
 * colocar uma mensagem real na fila e observar o consumidor reagir.
 */

export interface WagerTransactionMessageOverrides {
  messageId?: string;
  dataOverrides?: Record<string, unknown>;
}

export function buildWagerTransactionMessageBody(
  walletId: string,
  playerId: string,
  overrides: WagerTransactionMessageOverrides = {},
): string {
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
    ...overrides.dataOverrides,
  };

  return JSON.stringify({
    messageId: overrides.messageId ?? randomUUID(),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data,
  });
}

/**
 * `MessageGroupId`/`MessageDeduplicationId` explicitos e obrigatorios: a
 * fila tem `ContentBasedDeduplication=false` (Bloco 9a.3), entao o SQS
 * exige um id de deduplicacao explicito em todo SendMessage.
 * `MessageGroupId` deterministico por wallet — a mesma escolha que o futuro
 * publisher (Bloco 9c) provavelmente vai fazer, coerente com "a unidade de
 * concorrencia e a walletId" (CHALLENGE.md secao 8).
 */
export async function sendTestMessage(
  client: SQSClient,
  queueUrl: string,
  body: string,
  options: { messageGroupId: string; messageDeduplicationId: string },
): Promise<void> {
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: options.messageGroupId,
      MessageDeduplicationId: options.messageDeduplicationId,
    }),
  );
}

export async function waitFor(
  conditionFn: () => Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 150;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await conditionFn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`waitFor: condition "${options.description ?? 'unnamed'}" not met within ${timeoutMs}ms`);
}

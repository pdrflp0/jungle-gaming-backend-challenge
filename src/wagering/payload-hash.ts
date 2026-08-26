import { createHash } from 'node:crypto';

export interface WagerTransactionPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

/**
 * JSON canonico: chaves sempre em ordem alfabetica, recursivamente — nao a
 * ordem em que os campos foram declarados. Isso torna o hash independente
 * de como o objeto foi montado, sem depender de os campos virem numa ordem
 * especifica no payload original.
 */
function canonicalize(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * So os campos de negocio entram no hash — nunca o header Idempotency-Key
 * nem qualquer dado de transporte (IP, timestamp de chegada, etc.).
 */
export function computePayloadHash(payload: WagerTransactionPayload): string {
  const businessFields: WagerTransactionPayload = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount: payload.money.amount, currency: payload.money.currency },
    ...(payload.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: payload.referenceExternalTransactionId }
      : {}),
  };

  return createHash('sha256').update(canonicalize(businessFields)).digest('hex');
}

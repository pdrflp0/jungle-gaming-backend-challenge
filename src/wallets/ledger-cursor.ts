import { isUUID } from 'class-validator';

/**
 * Cursor opaco e estavel para paginacao do ledger (CHALLENGE.md secao 9).
 * Opaco: o cliente nao deveria montar um a mao, so devolver o que recebeu.
 * Nao e segredo nem autorizacao — nao carrega HMAC. Ainda assim e entrada
 * nao confiavel (vem de fora), entao a decodificacao e estrita: qualquer
 * desvio de formato (base64 invalido, data invalida, UUID invalido, campos
 * faltando) vira erro, nunca um valor aproximado.
 */

export interface LedgerCursor {
  createdAt: Date;
  id: string;
}

export class InvalidLedgerCursorError extends Error {
  constructor(cursor: string) {
    super(`Invalid ledger cursor: ${cursor}`);
    this.name = 'InvalidLedgerCursorError';
  }
}

const BASE64URL_FORMAT = /^[A-Za-z0-9_-]+$/;

export function encodeLedgerCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeLedgerCursor(cursor: string): LedgerCursor {
  // Buffer.from(..., 'base64url') nao lanca erro para lixo fora do alfabeto —
  // so ignora os caracteres invalidos. Por isso o formato e checado antes de
  // decodificar, em vez de confiar em uma excecao que nunca viria.
  if (!BASE64URL_FORMAT.test(cursor)) {
    throw new InvalidLedgerCursorError(cursor);
  }

  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const parts = decoded.split('|');
  if (parts.length !== 2) {
    throw new InvalidLedgerCursorError(cursor);
  }

  const [isoDate, id] = parts;
  if (!isoDate || !id || !isUUID(id)) {
    throw new InvalidLedgerCursorError(cursor);
  }

  const createdAt = new Date(isoDate);
  // toISOString() so bate com isoDate se a string original ja era um
  // timestamp ISO-8601 completo e valido — rejeita formatos parciais como
  // "2026-08-28" que o Date aceitaria mas nao sao o que este cursor emite.
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== isoDate) {
    throw new InvalidLedgerCursorError(cursor);
  }

  return { createdAt, id };
}

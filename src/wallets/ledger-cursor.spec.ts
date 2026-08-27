import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { decodeLedgerCursor, encodeLedgerCursor, InvalidLedgerCursorError } from './ledger-cursor';

describe('ledger cursor', () => {
  test('decodifica de volta exatamente o que foi codificado', () => {
    const createdAt = new Date('2026-08-28T12:34:56.789Z');
    const id = randomUUID();

    const cursor = encodeLedgerCursor(createdAt, id);
    const decoded = decodeLedgerCursor(cursor);

    expect(decoded.createdAt.toISOString()).toBe(createdAt.toISOString());
    expect(decoded.id).toBe(id);
  });

  test('rejeita string fora do alfabeto base64url', () => {
    expect(() => decodeLedgerCursor('nao e base64url!')).toThrow(InvalidLedgerCursorError);
  });

  test('rejeita base64url valido que nao decodifica em "data|uuid"', () => {
    const garbage = Buffer.from('isso nao tem o formato certo', 'utf8').toString('base64url');
    expect(() => decodeLedgerCursor(garbage)).toThrow(InvalidLedgerCursorError);
  });

  test('rejeita data invalida', () => {
    const cursor = Buffer.from(`nao-e-uma-data|${randomUUID()}`, 'utf8').toString('base64url');
    expect(() => decodeLedgerCursor(cursor)).toThrow(InvalidLedgerCursorError);
  });

  test('rejeita data parcial (nao ISO-8601 completo)', () => {
    const cursor = Buffer.from(`2026-08-28|${randomUUID()}`, 'utf8').toString('base64url');
    expect(() => decodeLedgerCursor(cursor)).toThrow(InvalidLedgerCursorError);
  });

  test('rejeita UUID invalido', () => {
    const cursor = Buffer.from('2026-08-28T12:00:00.000Z|nao-e-um-uuid', 'utf8').toString('base64url');
    expect(() => decodeLedgerCursor(cursor)).toThrow(InvalidLedgerCursorError);
  });

  test('rejeita campo faltando', () => {
    const cursor = Buffer.from('2026-08-28T12:00:00.000Z', 'utf8').toString('base64url');
    expect(() => decodeLedgerCursor(cursor)).toThrow(InvalidLedgerCursorError);
  });
});

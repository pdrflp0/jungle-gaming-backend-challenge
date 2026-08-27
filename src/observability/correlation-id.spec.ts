import { describe, expect, test } from 'bun:test';
import { resolveCorrelationId } from './correlation-id';

describe('resolveCorrelationId', () => {
  test('usa o header quando ele e uma string simples e limitada', () => {
    expect(resolveCorrelationId('req-123')).toBe('req-123');
    expect(resolveCorrelationId('0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1')).toBe(
      '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    );
  });

  test('gera um novo valor quando o header esta ausente', () => {
    const generated = resolveCorrelationId(undefined);
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('gera um novo valor quando o header contem caracteres fora do formato aceito', () => {
    const generated = resolveCorrelationId('valor com espaco e "aspas"');
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('gera um novo valor quando o header excede o tamanho maximo', () => {
    const tooLong = 'a'.repeat(101);
    const generated = resolveCorrelationId(tooLong);
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('gera um novo valor quando o header e uma string vazia', () => {
    const generated = resolveCorrelationId('');
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
  });
});

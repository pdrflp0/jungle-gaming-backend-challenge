import { describe, expect, test } from 'bun:test';
import { computeOutboxNextAttemptDelaySeconds } from './outbox-retry-backoff';

describe('computeOutboxNextAttemptDelaySeconds', () => {
  test('dobra a cada tentativa a partir da base de 5s', () => {
    expect(computeOutboxNextAttemptDelaySeconds(1)).toBe(5);
    expect(computeOutboxNextAttemptDelaySeconds(2)).toBe(10);
    expect(computeOutboxNextAttemptDelaySeconds(3)).toBe(20);
    expect(computeOutboxNextAttemptDelaySeconds(4)).toBe(40);
    expect(computeOutboxNextAttemptDelaySeconds(5)).toBe(80);
    expect(computeOutboxNextAttemptDelaySeconds(6)).toBe(160);
  });

  test('nunca ultrapassa o teto de 300s', () => {
    expect(computeOutboxNextAttemptDelaySeconds(7)).toBe(300);
    expect(computeOutboxNextAttemptDelaySeconds(8)).toBe(300);
    expect(computeOutboxNextAttemptDelaySeconds(20)).toBe(300);
  });
});

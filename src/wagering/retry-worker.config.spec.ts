import { describe, expect, test } from 'bun:test';
import { computeNextAttemptDelaySeconds } from './retry-worker.config';

describe('computeNextAttemptDelaySeconds', () => {
  test('dobra a cada tentativa a partir da base de 5s', () => {
    expect(computeNextAttemptDelaySeconds(1)).toBe(5);
    expect(computeNextAttemptDelaySeconds(2)).toBe(10);
    expect(computeNextAttemptDelaySeconds(3)).toBe(20);
    expect(computeNextAttemptDelaySeconds(4)).toBe(40);
    expect(computeNextAttemptDelaySeconds(5)).toBe(80);
    expect(computeNextAttemptDelaySeconds(6)).toBe(160);
  });

  test('nunca ultrapassa o teto de 300s', () => {
    expect(computeNextAttemptDelaySeconds(7)).toBe(300);
    expect(computeNextAttemptDelaySeconds(8)).toBe(300);
    expect(computeNextAttemptDelaySeconds(20)).toBe(300);
  });
});

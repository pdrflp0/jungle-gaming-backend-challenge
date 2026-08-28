import { describe, expect, test } from 'bun:test';
import { computePayloadHash } from './payload-hash';

const BASE_PAYLOAD = {
  providerId: 'provider-a',
  externalTransactionId: 'ext-1',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-1',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('computePayloadHash', () => {
  test('mesmo payload produz sempre o mesmo hash', () => {
    const first = computePayloadHash({ ...BASE_PAYLOAD });
    const second = computePayloadHash({ ...BASE_PAYLOAD });
    expect(first).toBe(second);
  });

  test('payload diferente produz hash diferente', () => {
    const first = computePayloadHash({ ...BASE_PAYLOAD });
    const second = computePayloadHash({ ...BASE_PAYLOAD, money: { amount: '30.00', currency: 'BRL' } });
    expect(first).not.toBe(second);
  });

  test('mesma informacao com chaves JSON em ordens diferentes produz o mesmo hash', () => {
    const first = computePayloadHash({
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });

    // mesmos valores, ordem de declaracao das chaves invertida (inclusive
    // dentro do objeto aninhado `money`) — o hash canonico nao pode depender
    // disso.
    const second = computePayloadHash({
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      externalTransactionId: 'ext-1',
      providerId: 'provider-a',
    });

    expect(first).toBe(second);
  });
});

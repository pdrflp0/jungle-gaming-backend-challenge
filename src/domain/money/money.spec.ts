import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InvalidMoneyAmountError,
  InvalidMoneyCurrencyError,
  Money,
  MoneyAmountOverflowError,
} from './money';

describe('Money.from — parsing e formato', () => {
  test('aceita uma string decimal valida', () => {
    const money = Money.from({ amount: '25.00', currency: 'BRL' });
    expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  test('normaliza entradas com menos de duas casas decimais', () => {
    expect(Money.from({ amount: '25', currency: 'BRL' }).toJSON().amount).toBe('25.00');
    expect(Money.from({ amount: '25.5', currency: 'BRL' }).toJSON().amount).toBe('25.50');
  });

  test('rejeita amount que nao e string em runtime, mesmo ignorando o TypeScript', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyAmountError,
    );
    expect(() => Money.from({ amount: null as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyAmountError,
    );
    expect(() => Money.from({ amount: undefined as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyAmountError,
    );
  });

  test('rejeita valores negativos', () => {
    expect(() => Money.from({ amount: '-10.00', currency: 'BRL' })).toThrow(InvalidMoneyAmountError);
  });

  test('rejeita NaN e Infinity como string', () => {
    expect(() => Money.from({ amount: 'NaN', currency: 'BRL' })).toThrow(InvalidMoneyAmountError);
    expect(() => Money.from({ amount: 'Infinity', currency: 'BRL' })).toThrow(InvalidMoneyAmountError);
  });

  test('rejeita notacao cientifica', () => {
    expect(() => Money.from({ amount: '1e10', currency: 'BRL' })).toThrow(InvalidMoneyAmountError);
  });

  test('rejeita string vazia e texto nao numerico', () => {
    expect(() => Money.from({ amount: '', currency: 'BRL' })).toThrow(InvalidMoneyAmountError);
    expect(() => Money.from({ amount: 'abc', currency: 'BRL' })).toThrow(InvalidMoneyAmountError);
  });

  test('rejeita mais de duas casas decimais — nunca arredonda', () => {
    expect(() => Money.from({ amount: '10.129', currency: 'BRL' })).toThrow(InvalidMoneyAmountError);
    // mesmo quando o valor "reduzido" seria igual a 10.12, o formato da string e invalido.
    expect(() => Money.from({ amount: '10.120', currency: 'BRL' })).toThrow(InvalidMoneyAmountError);
  });
});

describe('Money.from — moeda', () => {
  test('rejeita currency que nao e string em runtime', () => {
    expect(() => Money.from({ amount: '10.00', currency: 25 as unknown as string })).toThrow(
      InvalidMoneyCurrencyError,
    );
    expect(() => Money.from({ amount: '10.00', currency: null as unknown as string })).toThrow(
      InvalidMoneyCurrencyError,
    );
    expect(() => Money.from({ amount: '10.00', currency: undefined as unknown as string })).toThrow(
      InvalidMoneyCurrencyError,
    );
  });

  test('rejeita formato de moeda invalido', () => {
    expect(() => Money.from({ amount: '10.00', currency: 'brl' })).toThrow(InvalidMoneyCurrencyError);
    expect(() => Money.from({ amount: '10.00', currency: 'BRLL' })).toThrow(InvalidMoneyCurrencyError);
    expect(() => Money.from({ amount: '10.00', currency: '' })).toThrow(InvalidMoneyCurrencyError);
  });

  test('aceita qualquer codigo com formato valido, mesmo que nao exista no catalogo ISO-4217', () => {
    // A regex valida apenas forma (3 letras maiusculas) — validar o catalogo completo esta fora do escopo do MVP.
    expect(() => Money.from({ amount: '10.00', currency: 'ZZZ' })).not.toThrow();
  });
});

describe('Money.from — limite maximo (NUMERIC(19,2))', () => {
  test('aceita o valor maximo permitido', () => {
    const money = Money.from({ amount: '99999999999999999.99', currency: 'BRL' });
    expect(money.toJSON().amount).toBe('99999999999999999.99');
  });

  test('rejeita, antes de criar o Decimal, uma entrada com mais de 17 digitos inteiros', () => {
    // "100000000000000000.00" e o proximo valor apos o maximo — e tambem o primeiro com 18 digitos inteiros.
    expect(() => Money.from({ amount: '100000000000000000.00', currency: 'BRL' })).toThrow(
      MoneyAmountOverflowError,
    );
  });
});

describe('Money.zero', () => {
  test('cria um valor zero para a moeda informada', () => {
    const zero = Money.zero('BRL');
    expect(zero.isZero()).toBe(true);
    expect(zero.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  test('valida a moeda da mesma forma que from()', () => {
    expect(() => Money.zero('brl')).toThrow(InvalidMoneyCurrencyError);
    expect(() => Money.zero(null as unknown as string)).toThrow(InvalidMoneyCurrencyError);
  });
});

describe('aritmetica', () => {
  test('add soma valores na mesma moeda', () => {
    const result = Money.from({ amount: '10.00', currency: 'BRL' }).add(
      Money.from({ amount: '5.00', currency: 'BRL' }),
    );
    expect(result.toJSON().amount).toBe('15.00');
  });

  test('add rejeita moedas diferentes', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '5.00', currency: 'USD' });
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
  });

  test('subtract calcula a diferenca na mesma moeda', () => {
    const result = Money.from({ amount: '10.00', currency: 'BRL' }).subtract(
      Money.from({ amount: '5.00', currency: 'BRL' }),
    );
    expect(result.toJSON().amount).toBe('5.00');
  });

  test('subtract pode resultar em valor negativo — Money nao impede isso, Wallet impedira', () => {
    const result = Money.from({ amount: '5.00', currency: 'BRL' }).subtract(
      Money.from({ amount: '10.00', currency: 'BRL' }),
    );
    expect(result.isNegative()).toBe(true);
    expect(result.toJSON().amount).toBe('-5.00');
  });

  test('subtract rejeita moedas diferentes', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '5.00', currency: 'USD' });
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
  });

  test('negate inverte o sinal preservando a moeda', () => {
    const positive = Money.from({ amount: '10.00', currency: 'BRL' });
    const negative = positive.negate();
    expect(negative.toJSON()).toEqual({ amount: '-10.00', currency: 'BRL' });
    expect(negative.negate().equals(positive)).toBe(true);
  });

  test('resultado aritmetico que ultrapassa o limite maximo lanca MoneyAmountOverflowError', () => {
    const nearMax = Money.from({ amount: '60000000000000000.00', currency: 'BRL' });
    expect(() => nearMax.add(nearMax)).toThrow(MoneyAmountOverflowError);
  });
});

describe('consultas', () => {
  test('isZero, isPositive e isNegative', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(Money.from({ amount: '1.00', currency: 'BRL' }).isPositive()).toBe(true);
    expect(Money.from({ amount: '1.00', currency: 'BRL' }).negate().isNegative()).toBe(true);
  });

  test('isLessThan compara magnitude na mesma moeda', () => {
    const five = Money.from({ amount: '5.00', currency: 'BRL' });
    const ten = Money.from({ amount: '10.00', currency: 'BRL' });
    expect(five.isLessThan(ten)).toBe(true);
    expect(ten.isLessThan(five)).toBe(false);
    expect(five.isLessThan(five)).toBe(false);
  });

  test('isLessThan rejeita moedas diferentes', () => {
    const brl = Money.from({ amount: '5.00', currency: 'BRL' });
    const usd = Money.from({ amount: '5.00', currency: 'USD' });
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test('equals compara quantia e moeda, sem lancar erro para moedas diferentes', () => {
    const brl10 = Money.from({ amount: '10.00', currency: 'BRL' });
    const brl10Again = Money.from({ amount: '10.00', currency: 'BRL' });
    const brl5 = Money.from({ amount: '5.00', currency: 'BRL' });
    const usd10 = Money.from({ amount: '10.00', currency: 'USD' });

    expect(brl10.equals(brl10Again)).toBe(true);
    expect(brl10.equals(brl5)).toBe(false);
    expect(() => brl10.equals(usd10)).not.toThrow();
    expect(brl10.equals(usd10)).toBe(false);
  });
});

describe('serializacao', () => {
  test('toJSON sempre usa escala fixa de duas casas', () => {
    expect(Money.from({ amount: '25', currency: 'BRL' }).toJSON()).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
  });

  test('toString retorna "MOEDA valor" com duas casas', () => {
    expect(Money.from({ amount: '25', currency: 'BRL' }).toString()).toBe('BRL 25.00');
    // "from" rejeita string negativa (regra de entrada) — o negativo aqui vem de negate(), nao de from().
    expect(Money.from({ amount: '5.00', currency: 'BRL' }).negate().toString()).toBe('BRL -5.00');
  });
});

describe('imutabilidade', () => {
  test('add, subtract e negate retornam uma nova instancia sem alterar a original', () => {
    const original = Money.from({ amount: '10.00', currency: 'BRL' });

    original.add(Money.from({ amount: '5.00', currency: 'BRL' }));
    original.subtract(Money.from({ amount: '3.00', currency: 'BRL' }));
    original.negate();

    expect(original.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
  });
});

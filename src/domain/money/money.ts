import Decimal from 'decimal.js';

export interface MoneyProps {
  amount: string; // decimal string, ex.: "25.00"
  currency: string; // ISO-4217, ex.: "BRL"
}

export class InvalidMoneyAmountError extends Error {
  constructor(amount: unknown) {
    super(`Invalid money amount: ${String(amount)}`);
    this.name = 'InvalidMoneyAmountError';
  }
}

export class InvalidMoneyCurrencyError extends Error {
  constructor(currency: unknown) {
    super(`Invalid money currency: ${String(currency)}`);
    this.name = 'InvalidMoneyCurrencyError';
  }
}

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Currency mismatch: ${a} vs ${b}`);
    this.name = 'CurrencyMismatchError';
  }
}

export class MoneyAmountOverflowError extends Error {
  constructor(amount: unknown) {
    super(`Money amount exceeds the maximum allowed value: ${String(amount)}`);
    this.name = 'MoneyAmountOverflowError';
  }
}

/** Aceita "25", "25.5" ou "25.00" — nunca sinal, notacao cientifica ou mais de 2 casas. */
const AMOUNT_FORMAT = /^\d+(\.\d{1,2})?$/;

/** Valida apenas o formato (3 letras maiusculas) — nao o catalogo ISO-4217. */
const CURRENCY_FORMAT = /^[A-Z]{3}$/;

/** Alinhado a uma futura coluna NUMERIC(19,2): 17 digitos inteiros + 2 decimais. */
const MAX_INTEGER_DIGITS = 17;

export class Money {
  private static readonly MAX_AMOUNT = new Decimal('99999999999999999.99');

  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (typeof props.amount !== 'string') {
      throw new InvalidMoneyAmountError(props.amount);
    }
    Money.assertValidCurrency(props.currency);

    if (!AMOUNT_FORMAT.test(props.amount)) {
      throw new InvalidMoneyAmountError(props.amount);
    }

    const integerDigits = props.amount.split('.')[0].length;
    if (integerDigits > MAX_INTEGER_DIGITS) {
      throw new MoneyAmountOverflowError(props.amount);
    }

    return Money.of(new Decimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    Money.assertValidCurrency(currency);
    return Money.of(new Decimal(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.of(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.currency} ${this.value.toFixed(2)}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertValidCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string' || !CURRENCY_FORMAT.test(currency)) {
      throw new InvalidMoneyCurrencyError(currency);
    }
  }

  /** Unico ponto por onde todo Money nasce — garante o limite mesmo apos aritmetica. */
  private static of(value: Decimal, currency: string): Money {
    if (value.abs().greaterThan(Money.MAX_AMOUNT)) {
      throw new MoneyAmountOverflowError(value.toString());
    }
    return new Money(value, currency);
  }
}

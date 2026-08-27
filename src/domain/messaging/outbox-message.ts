import { IntegrationEvent } from './integration-event';
import { computeOutboxNextAttemptDelaySeconds } from './outbox-retry-backoff';

/**
 * Dominio da Outbox (CHALLENGE.md secao 6.5/11). Registra a INTENCAO de
 * publicar um evento — nunca publica nada. `enqueue` preserva o evento
 * recebido: usa `event.eventId` como id da linha, `event.eventType` como
 * tipo, e o envelope completo (`event.toJSON()`) como payload, nao so
 * `event.data`. Nesta 9a.1 nenhum chamador real usa `enqueue` ainda (isso e
 * o Bloco 9a.2) — a classe so precisa se comportar corretamente.
 */

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessageAlreadyPublishedError extends Error {
  constructor() {
    super('Outbox message was already published');
    this.name = 'OutboxMessageAlreadyPublishedError';
  }
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** Nasce pendente e imediatamente devida: nextAttemptAt = occurredAt. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    // O envelope (`toJSON()`) e um tipo com campos nomeados, nao um Record —
    // o cast e so para satisfazer a assinatura de armazenamento generica;
    // o conteudo em runtime e exatamente o envelope, sem perda nem invencao.
    const payload = event.toJSON() as unknown as Readonly<Record<string, unknown>>;

    return new OutboxMessage(event.eventId, event.aggregateId, event.eventType, payload, event.occurredAt, 0, event.occurredAt);
  }

  /** Reconstrucao a partir da persistencia — nao revalida, so reconstroi. */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt !== undefined && this._nextAttemptAt <= now;
  }

  /** Terminal: publicacao encerra o ciclo de retry, `nextAttemptAt` volta a undefined. */
  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new OutboxMessageAlreadyPublishedError();
    }
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  scheduleRetry(now: Date): void {
    if (!this.isPending()) {
      throw new OutboxMessageAlreadyPublishedError();
    }
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + computeOutboxNextAttemptDelaySeconds(this._attempts) * 1000);
  }
}

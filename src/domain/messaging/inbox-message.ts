/**
 * Dominio da Inbox (CHALLENGE.md secao 6.5). Identidade real e
 * (consumerName, messageId) — nao existe id substituto. Nesta 9a.1 a classe
 * existe e sabe se comportar, mas nenhum consumidor real a usa ainda (isso
 * e o Bloco 9b).
 */

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export class InboxMessageAlreadyProcessedError extends Error {
  constructor() {
    super('Inbox message was already marked as processed');
    this.name = 'InboxMessageAlreadyProcessedError';
  }
}

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  /** Nasce nao processada. */
  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt);
  }

  /** Reconstrucao a partir da persistencia — nao revalida, so reconstroi. */
  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InboxMessageAlreadyProcessedError();
    }
    this._processedAt = at;
  }
}

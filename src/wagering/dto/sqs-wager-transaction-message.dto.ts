import { Type } from 'class-transformer';
import { IsIn, IsISO8601, IsString, ValidateNested } from 'class-validator';
import { SubmitWagerTransactionDto } from './submit-wager-transaction.dto';

/**
 * Envelope da fila `wager-transactions.fifo` (CHALLENGE.md secao 10). `data`
 * tem os mesmos campos de negocio do corpo HTTP mais `idempotencyKey` (que
 * no HTTP vem de um header, aqui vem embutido no corpo) — por isso estende
 * SubmitWagerTransactionDto em vez de duplicar as 8 regras de validacao. Os
 * mesmos `kind` aceitos pelo HTTP (BET/WIN/LOSS/REFUND/ROLLBACK, nunca
 * OPENING) valem aqui, de graca, por heranca.
 */
export class SqsWagerTransactionDataDto extends SubmitWagerTransactionDto {
  @IsString()
  idempotencyKey!: string;
}

export class WagerTransactionRequestedMessageDto {
  @IsString()
  messageId!: string;

  @IsIn(['WagerTransactionRequested'])
  type!: 'WagerTransactionRequested';

  @IsISO8601()
  occurredAt!: string;

  @ValidateNested()
  @Type(() => SqsWagerTransactionDataDto)
  data!: SqsWagerTransactionDataDto;
}

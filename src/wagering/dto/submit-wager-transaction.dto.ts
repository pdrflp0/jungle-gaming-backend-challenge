import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, Matches, ValidateNested } from 'class-validator';

export class SubmitWagerMoneyDto {
  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message: 'amount must be a decimal string with up to 2 decimal places',
  })
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must contain exactly 3 uppercase letters' })
  currency!: string;
}

export class SubmitWagerTransactionDto {
  @IsString()
  providerId!: string;

  @IsString()
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  roundId!: string;

  @IsString()
  gameId!: string;

  @IsIn(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'])
  kind!: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

  @ValidateNested()
  @Type(() => SubmitWagerMoneyDto)
  money!: SubmitWagerMoneyDto;

  // Obrigatoria para REFUND/ROLLBACK (o dominio recusa a criacao sem isso via
  // MissingReferenceError -> 400). Opcional para WIN (referencia so a BET da
  // mesma rodada, se o provider quiser correlacionar). BET e LOSS nunca usam.
  @IsOptional()
  @IsString()
  referenceExternalTransactionId?: string;
}

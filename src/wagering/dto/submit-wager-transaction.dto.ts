import { Type } from 'class-transformer';
import { IsIn, IsString, IsUUID, Matches, ValidateNested } from 'class-validator';

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

  // Somente BET neste bloco. Ampliar esta lista e o caso de uso e o ponto de
  // extensao para WIN/LOSS/REFUND/ROLLBACK em blocos futuros.
  @IsIn(['BET'])
  kind!: 'BET';

  @ValidateNested()
  @Type(() => SubmitWagerMoneyDto)
  money!: SubmitWagerMoneyDto;
}

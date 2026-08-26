import { Type } from 'class-transformer';
import { IsString, IsUUID, Matches, ValidateNested } from 'class-validator';

export class MoneyDto {
  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message: 'amount must be a decimal string with up to 2 decimal places',
  })
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must contain exactly 3 uppercase letters' })
  currency!: string;
}

export class OpenWalletDto {
  @IsUUID()
  playerId!: string;

  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}

import { IsString, IsObject, IsNumber, IsBoolean, IsOptional } from 'class-validator';

export class StripeWebhookDto {
  @IsString()
  id: string;

  @IsString()
  type: string;

  @IsObject()
  data: {
    object: any;
  };

  @IsNumber()
  created: number;

  @IsBoolean()
  livemode: boolean;

  @IsOptional()
  @IsString()
  request?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, string>;
}

export class StripeEventDto {
  @IsString()
  type: string;

  @IsObject()
  data: {
    object: any;
  };

  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsNumber()
  created?: number;

  @IsOptional()
  @IsBoolean()
  livemode?: boolean;
}

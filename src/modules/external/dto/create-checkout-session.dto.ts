import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsOptional, IsString, IsUUID, Matches } from 'class-validator';

export class CreateCheckoutSessionDto {
  @ApiProperty({ description: 'Telefone do usuário em formato internacional (E.164)' })
  @IsString()
  phone: string;

  @ApiProperty({ description: 'Email do usuário', example: 'user@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ description: 'ID do plano selecionado' })
  @IsString()
  plan_id: string;

  @ApiProperty({ enum: ['monthly', 'yearly'] as const })
  @IsEnum(['monthly', 'yearly'] as const)
  interval: 'monthly' | 'yearly';

  @ApiProperty({ required: false, description: 'Jurisdição (override de detecção por telefone). Ex.: PT, ES, BR' })
  @IsOptional()
  @IsString()
  jurisdiction?: string;

  @ApiProperty({ required: false, description: 'URL de Sucesso' })
  @IsOptional()
  @IsString()
  success_url?: string;
}



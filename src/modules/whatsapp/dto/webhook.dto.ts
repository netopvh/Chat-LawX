import { IsString, IsOptional, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MessageDto {
  @ApiProperty()
  @IsString()
  key: {
    remoteJid: string;
    fromMe: boolean;
    id: string;
  };

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  message?: {
    conversation?: string;
    imageMessage?: {
      url: string;
      mimetype: string;
      caption?: string;
    };
  };

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  messageTimestamp?: string;
}

export class WebhookDto {
  @ApiProperty()
  @IsString()
  event: string;

  @ApiProperty()
  @IsString()
  instance: string;

  @ApiProperty()
  @ValidateNested({ each: true })
  @Type(() => MessageDto)
  @IsArray()
  data: MessageDto[];
} 
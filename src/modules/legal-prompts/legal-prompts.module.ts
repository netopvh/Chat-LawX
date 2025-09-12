import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LegalPromptsService } from './legal-prompts.service';

@Module({
  imports: [ConfigModule],
  providers: [LegalPromptsService],
  exports: [LegalPromptsService],
})
export class LegalPromptsModule {}

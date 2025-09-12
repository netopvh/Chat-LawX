import { Module } from '@nestjs/common';
import { LegalPromptsService } from './legal-prompts.service';
import { LegalPromptsController } from './legal-prompts.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [LegalPromptsService],
  controllers: [LegalPromptsController],
  exports: [LegalPromptsService],
})
export class LegalPromptsModule {}
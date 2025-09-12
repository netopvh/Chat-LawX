import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { LegalPromptsModule } from '../legal-prompts/legal-prompts.module';
import { JurisdictionModule } from '../jurisdiction/jurisdiction.module';
import { TeamsModule } from '../teams/teams.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    LegalPromptsModule,
    JurisdictionModule,
    TeamsModule,
    PrismaModule,
  ],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {} 
import { Module } from '@nestjs/common';
import { AnalysisTimeoutService } from './analysis-timeout.service';
import { AnalysisTimeoutController } from './analysis-timeout.controller';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { TeamsModule } from '../teams/teams.module';

@Module({
  imports: [WhatsAppModule, TeamsModule],
  controllers: [AnalysisTimeoutController],
  providers: [AnalysisTimeoutService],
  exports: [AnalysisTimeoutService],
})
export class AnalysisTimeoutModule {}

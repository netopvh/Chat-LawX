import { Module } from '@nestjs/common';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';
import { UsersModule } from '../users/users.module';
import { AiModule } from '../ai/ai.module';
import { UploadModule } from '../upload/upload.module';
import { UsageModule } from '../usage/usage.module';
import { StripeModule } from '../stripe/stripe.module';
import { UpgradeSessionsModule } from '../upgrade-sessions/upgrade-sessions.module';
import { PlansModule } from '../plans/plans.module';
import { JurisdictionModule } from '../jurisdiction/jurisdiction.module';
import { TeamsModule } from '../teams/teams.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    UsersModule, 
    AiModule, 
    UploadModule, 
    UsageModule, 
    StripeModule, 
    UpgradeSessionsModule, 
    PlansModule,
    JurisdictionModule,
    TeamsModule,
    PrismaModule,
  ],
  controllers: [WhatsAppController],
  providers: [WhatsAppService],
})
export class WhatsAppModule {} 
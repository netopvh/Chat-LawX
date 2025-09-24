import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { UsersModule } from './modules/users/users.module';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';
import { SupabaseModule } from './modules/supabase/supabase.module';
import { AiModule } from './modules/ai/ai.module';
import { UsageModule } from './modules/usage/usage.module';
import { UploadModule } from './modules/upload/upload.module';
import { PlansModule } from './modules/plans/plans.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { UpgradeSessionsModule } from './modules/upgrade-sessions/upgrade-sessions.module';
import { PrismaModule } from './modules/prisma/prisma.module';
import { StripeModule } from './modules/stripe/stripe.module';
import { JurisdictionModule } from './modules/jurisdiction/jurisdiction.module';
import { TeamsModule } from './modules/teams/teams.module';
import { LegalPromptsModule } from './modules/legal-prompts/legal-prompts.module';
import { AnalysisTimeoutModule } from './modules/analysis-timeout/analysis-timeout.module';
import { ExternalModule } from './modules/external/external.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    SupabaseModule,
    StripeModule,
    JurisdictionModule,
    TeamsModule,
    LegalPromptsModule,
    UsersModule,
    WhatsAppModule,
    AiModule,
    UsageModule,
    UploadModule,
    PlansModule,
    SubscriptionsModule,
    UpgradeSessionsModule,
    AnalysisTimeoutModule,
    ExternalModule,
  ],
})
export class AppModule {} 
import { Module } from '@nestjs/common';
import { UsageService } from './usage.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { PlansModule } from '../plans/plans.module';
import { JurisdictionModule } from '../jurisdiction/jurisdiction.module';
import { TeamsModule } from '../teams/teams.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    SupabaseModule, 
    SubscriptionsModule, 
    PlansModule,
    JurisdictionModule,
    TeamsModule,
    PrismaModule,
  ],
  providers: [UsageService],
  exports: [UsageService],
})
export class UsageModule {} 
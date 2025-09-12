import { Module } from '@nestjs/common';
import { UsageService } from './usage.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { PlansModule } from '../plans/plans.module';

@Module({
  imports: [SupabaseModule, SubscriptionsModule, PlansModule],
  providers: [UsageService],
  exports: [UsageService],
})
export class UsageModule {} 
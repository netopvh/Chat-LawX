import { Module } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { PlansModule } from '../plans/plans.module';

@Module({
  imports: [SupabaseModule, PlansModule],
  providers: [SubscriptionsService],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {} 
import { Module, forwardRef } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { PlansModule } from '../plans/plans.module';
import { StripeModule } from '../stripe/stripe.module';
import { JurisdictionModule } from '../jurisdiction/jurisdiction.module';

@Module({
  imports: [
    SupabaseModule, 
    PlansModule,
    forwardRef(() => StripeModule),
    JurisdictionModule,
  ],
  providers: [SubscriptionsService],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {} 
import { Module } from '@nestjs/common';
import { UpgradeSessionsService } from './upgrade-sessions.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { PlansModule } from '../plans/plans.module';
import { StripeModule } from '../stripe/stripe.module';
import { JurisdictionModule } from '../jurisdiction/jurisdiction.module';

@Module({
  imports: [
    SupabaseModule, 
    PlansModule,
    StripeModule,
    JurisdictionModule,
  ],
  providers: [UpgradeSessionsService],
  exports: [UpgradeSessionsService],
})
export class UpgradeSessionsModule {} 
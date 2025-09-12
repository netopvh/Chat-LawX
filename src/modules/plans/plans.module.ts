import { Module } from '@nestjs/common';
import { PlansService } from './plans.service';
import { PlansController } from './plans.controller';
import { SupabaseModule } from '../supabase/supabase.module';
import { StripeModule } from '../stripe/stripe.module';
import { JurisdictionModule } from '../jurisdiction/jurisdiction.module';

@Module({
  imports: [
    SupabaseModule,
    StripeModule,
    JurisdictionModule,
  ],
  controllers: [PlansController],
  providers: [PlansService],
  exports: [PlansService],
})
export class PlansModule {} 
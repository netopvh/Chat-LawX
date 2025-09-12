import { Module } from '@nestjs/common';
import { UpgradeSessionsService } from './upgrade-sessions.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { PlansModule } from '../plans/plans.module';

@Module({
  imports: [SupabaseModule, PlansModule],
  providers: [UpgradeSessionsService],
  exports: [UpgradeSessionsService],
})
export class UpgradeSessionsModule {} 
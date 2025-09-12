import { Module } from '@nestjs/common';
import { TeamsService } from './teams.service';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [SupabaseModule],
  providers: [TeamsService],
  exports: [TeamsService],
})
export class TeamsModule {}

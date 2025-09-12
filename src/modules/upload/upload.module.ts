import { Module } from '@nestjs/common';
import { UploadService } from './upload.service';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [SupabaseModule],
  providers: [UploadService],
  exports: [UploadService],
})
export class UploadModule {} 
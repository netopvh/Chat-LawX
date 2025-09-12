import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JurisdictionService } from './jurisdiction.service';

@Module({
  imports: [ConfigModule],
  providers: [JurisdictionService],
  exports: [JurisdictionService],
})
export class JurisdictionModule {}

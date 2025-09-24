import { Module } from '@nestjs/common';
import { ExternalController } from './external.controller';
import { PlansModule } from '../plans/plans.module';
import { StripeModule } from '../stripe/stripe.module';
import { UsersModule } from '../users/users.module';
import { JurisdictionModule } from '../jurisdiction/jurisdiction.module';

@Module({
  imports: [PlansModule, StripeModule, UsersModule, JurisdictionModule],
  controllers: [ExternalController],
})
export class ExternalModule {}






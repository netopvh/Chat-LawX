import { Module } from '@nestjs/common';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';
import { UsersModule } from '../users/users.module';
import { ExpensesModule } from '../expenses/expenses.module';
import { RevenuesModule } from '../revenues/revenues.module';
import { AiModule } from '../ai/ai.module';
import { UploadModule } from '../upload/upload.module';
import { UsageModule } from '../usage/usage.module';
import { MercadoPagoModule } from '../mercadopago/mercadopago.module';
import { UpgradeSessionsModule } from '../upgrade-sessions/upgrade-sessions.module';
import { PlansModule } from '../plans/plans.module';

@Module({
  imports: [
    UsersModule, 
    ExpensesModule, 
    RevenuesModule,
    AiModule, 
    UploadModule, 
    UsageModule, 
    MercadoPagoModule, 
    UpgradeSessionsModule, 
    PlansModule
  ],
  controllers: [WhatsAppController],
  providers: [WhatsAppService],
})
export class WhatsAppModule {} 
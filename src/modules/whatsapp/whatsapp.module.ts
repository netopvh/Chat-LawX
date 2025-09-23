import { Module } from '@nestjs/common';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';
import { UsersModule } from '../users/users.module';
import { AiModule } from '../ai/ai.module';
import { UploadModule } from '../upload/upload.module';
import { UsageModule } from '../usage/usage.module';
import { StripeModule } from '../stripe/stripe.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { UpgradeSessionsModule } from '../upgrade-sessions/upgrade-sessions.module';
import { PlansModule } from '../plans/plans.module';
import { JurisdictionModule } from '../jurisdiction/jurisdiction.module';
import { TeamsModule } from '../teams/teams.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SupabaseModule } from '../supabase/supabase.module';
import { WhatsAppClient } from './services/clients/whatsapp.client';
import { AIGateway } from './services/clients/ai.gateway';
import { CONVERSATION_STATE_STORE } from './interfaces/conversation-state-store.interface';
import { InMemoryConversationStateStore } from './services/state/in-memory.conversation-state.store';
import { MediaDownloader } from './services/media/media-downloader';
import { AudioProcessor } from './services/media/audio-processor';
import { DocumentProcessor } from './services/media/document-processor';
import { JurisdictionRouter } from './app/jurisdiction.router';
import { BrazilHandler } from './handlers/brazil.handler';
import { PortugalHandler } from './handlers/portugal.handler';
import { SpainHandler } from './handlers/spain.handler';
import { BrazilSessionRepository } from './services/session/brazil-session.repository';
import { IberiaSessionRepository } from './services/session/iberia-session.repository';
import { SessionService } from './services/session/session.service';
import { UpgradeFlowEngine } from './services/upgrade/upgrade-flow.engine';
import { HttpClientService } from './services/clients/http.client';

@Module({
  imports: [
    UsersModule, 
    AiModule, 
    UploadModule, 
    UsageModule, 
    StripeModule, 
    SubscriptionsModule,
    UpgradeSessionsModule, 
    PlansModule,
    JurisdictionModule,
    TeamsModule,
    PrismaModule,
    SupabaseModule,
  ],
  controllers: [WhatsAppController],
  providers: [
    WhatsAppService, 
    WhatsAppClient, 
    AIGateway,
    { provide: CONVERSATION_STATE_STORE, useClass: InMemoryConversationStateStore },
    MediaDownloader,
    AudioProcessor,
    DocumentProcessor,
    JurisdictionRouter,
    BrazilHandler,
    PortugalHandler,
    SpainHandler,
    BrazilSessionRepository,
    IberiaSessionRepository,
    SessionService,
    UpgradeFlowEngine,
    HttpClientService,
  ],
  exports: [
    WhatsAppService, 
    WhatsAppClient, 
    AIGateway, 
    MediaDownloader, 
    AudioProcessor, 
    DocumentProcessor,
    JurisdictionRouter,
    BrazilHandler,
    PortugalHandler,
    SpainHandler,
  ],
})
export class WhatsAppModule {} 
import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { UsersService, User } from '../users/users.service';
import { AiService } from '../ai/ai.service';
import { UsageService } from '../usage/usage.service';
import { UploadService } from '../upload/upload.service';
import { StripeService } from '../stripe/stripe.service';
import { UpgradeSessionsService } from '../upgrade-sessions/upgrade-sessions.service';
import { PlansService } from '../plans/plans.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { JurisdictionService } from '../jurisdiction/jurisdiction.service';
import { TeamsService } from '../teams/teams.service';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { WebhookDto } from './dto/webhook.dto';
import { WhatsAppClient } from './services/clients/whatsapp.client';
import { CloudWhatsAppClient } from './services/clients/whatsapp.cloud.client';
import { AIGateway } from './services/clients/ai.gateway';
import { JurisdictionRouter } from './app/jurisdiction.router';
import { CONVERSATION_STATE_STORE, IConversationStateStore } from './interfaces/conversation-state-store.interface';
import { MediaDownloader } from './services/media/media-downloader';
import { CloudMediaService } from './services/media/cloud-media.service';
import { AudioProcessor } from './services/media/audio-processor';
import { DocumentProcessor } from './services/media/document-processor';
import { MessagingLogService } from './services/logging/messaging-log.service';
import { MessagingLogSupabaseService } from './services/logging/messaging-log.supabase.service';
import { ContextBuilderService } from './services/logging/context-builder.service';
import { SessionService } from './services/session/session.service';
import { UpgradeFlowEngine } from './services/upgrade/upgrade-flow.engine';
import { getJurisdiction, getJurisdictionLanguage } from '@/common/utils/jurisdiction';
import { CloudWebhookAdapter, NormalizedInboundMessage } from './adapters/cloud-webhook.adapter';

interface ConversationState {
  isWaitingForName: boolean;
  isWaitingForEmail: boolean;
  isWaitingForConfirmation: boolean;
  isWaitingForBrazilianName: boolean;
  isWaitingForWhatsAppName: boolean; // NOVO: Para controle de nome em ES/PT
  isInUpgradeFlow: boolean;
  isInRegistrationFlow: boolean;
  registrationStep: 'introduction' | 'name' | 'email' | 'confirmation' | 'completed';
  upgradeStep: 'introduction' | 'plan_selection' | 'frequency_selection' | 'payment_info' | 'confirmation';
  selectedPlan?: string;
  selectedFrequency?: 'monthly' | 'yearly';
  isInAnalysis: boolean;
  analysisStartTime?: number;
  pendingDocument?: any;
  jurisdiction?: string;
  ddi?: string;
  pendingName?: string;
  pendingEmail?: string;
  conversationId?: string;
  // Marca se o inbound atual veio via API Oficial (Cloud) para roteamento do transporte
  isCloudTransport?: boolean;
}

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  // Idempotência para mensagens Cloud (retries)
  private processedMessageIds = new Map<string, number>(); // messageId -> timestamp
  
  private createDefaultState(): ConversationState {
    return {
      isWaitingForName: false,
      isWaitingForEmail: false,
      isWaitingForConfirmation: false,
      isWaitingForBrazilianName: false,
      isWaitingForWhatsAppName: false,
      isInUpgradeFlow: false,
      isInRegistrationFlow: false,
      registrationStep: 'introduction',
      upgradeStep: 'introduction',
      isInAnalysis: false,
      analysisStartTime: undefined,
    };
  }

  // Array de números para forçar fluxo ES via variável de ambiente TEST_NUMBERS
  private readonly testNumbersForESFlow: string[];

  constructor(
    private configService: ConfigService,
    private aiService: AiService,
    private usageService: UsageService,
    private uploadService: UploadService,
    private usersService: UsersService,
    private upgradeSessionsService: UpgradeSessionsService,
    private plansService: PlansService,
    private subscriptionsService: SubscriptionsService,
    private stripeService: StripeService,
    private jurisdictionService: JurisdictionService,
    private teamsService: TeamsService,
    private prismaService: PrismaService,
    private supabaseService: SupabaseService,
    private whatsappClient: WhatsAppClient,
    private cloudClient: CloudWhatsAppClient,
    private aiGateway: AIGateway,
    private jurisdictionRouter: JurisdictionRouter,
    @Inject(CONVERSATION_STATE_STORE) private stateStore: IConversationStateStore<ConversationState>,
    private mediaDownloader: MediaDownloader,
    private cloudMedia: CloudMediaService,
    private audioProcessor: AudioProcessor,
    private documentProcessor: DocumentProcessor,
    private sessionService: SessionService,
    private upgradeFlowEngine: UpgradeFlowEngine,
    private messagingLog: MessagingLogService,
    private messagingLogBr: MessagingLogSupabaseService,
    private contextBuilder: ContextBuilderService,
  ) {
    // Inicializar números de teste a partir da env TEST_NUMBERS (comma-separated)
    this.testNumbersForESFlow = this.parseTestNumbersFromEnv();
  }

  private hasProcessedMessage(messageId?: string): boolean {
    if (!messageId) return false;
    const now = Date.now();
    // limpeza simples (TTL 15 min)
    for (const [id, ts] of this.processedMessageIds) {
      if (now - ts > 15 * 60 * 1000) this.processedMessageIds.delete(id);
    }
    return this.processedMessageIds.has(messageId);
  }

  private markMessageProcessed(messageId?: string): void {
    if (!messageId) return;
    this.processedMessageIds.set(messageId, Date.now());
  }

  private parseTestNumbersFromEnv(): string[] {
    try {
      const raw = this.configService.get<string>('TEST_NUMBERS');
      if (!raw) return [];
      return raw
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n.length > 0);
    } catch (error) {
      this.logger.warn('⚠️ Variável TEST_NUMBERS inválida. Usando lista vazia.');
      return [];
    }
  }

  // Métodos auxiliares para buscar planos dinamicamente
  private async getAllActivePlans() {
    try {
      return await this.plansService.getAllPlans();
    } catch (error) {
      this.logger.error('Erro ao buscar planos ativos:', error);
      throw error;
    }
  }

  private async getUpgradePlans(jurisdiction?: string) {
    try {
      return await this.plansService.getUpgradePlans(jurisdiction);
    } catch (error) {
      this.logger.error('Erro ao buscar planos de upgrade:', error);
      throw error;
    }
  }

  private async getPlanByName(planName: string) {
    try {
      return await this.plansService.getPlanByName(planName);
    } catch (error) {
      this.logger.error(`Erro ao buscar plano ${planName}:`, error);
      throw error;
    }
  }

  private async getPlanPrice(planName: string, billingCycle: 'monthly' | 'yearly'): Promise<number> {
    try {
      const plan = await this.plansService.getPlanByName(planName);
      return billingCycle === 'monthly' ? plan.monthly_price : plan.yearly_price;
    } catch (error) {
      this.logger.error(`Erro ao buscar preço do plano ${planName}:`, error);
      throw error;
    }
  }

  private resolveUpgradeJurisdiction(phone: string, existingSession?: any): string {
    if (existingSession?.jurisdiction) return existingSession.jurisdiction;
    const state = this.getConversationState(phone);
    if (state?.jurisdiction) return state.jurisdiction;
    return this.jurisdictionService.detectJurisdiction(phone).jurisdiction;
  }

  private async getPlanLimits(planName: string, jurisdiction: string): Promise<string> {
    try {
      const plan = await this.plansService.getPlanByName(planName);

      const isES = jurisdiction === 'ES';

      if (plan.is_unlimited) {
        return isES
          ? '• Consultas jurídicas ilimitadas\n• Análisis de documentos ilimitado\n• Mensajes ilimitados'
          : '• Consultas jurídicas ilimitadas\n• Análise de documentos ilimitada\n• Mensagens ilimitadas';
      } else {
        const limitControlType = this.jurisdictionService.getLimitControlType(jurisdiction);

        if (limitControlType === 'teams') {
          // Brasil (ou quando controle for por sistema)
          return isES
            ? '• Consultas jurídicas controladas por el sistema\n• Análisis de documentos controlado por el sistema\n• Mensajes controlados por el sistema'
            : '• Consultas jurídicas controladas via sistema\n• Análise de documentos controlada via sistema\n• Mensagens controladas via sistema';
        } else {
          // PT/ES - limites locais (exibição simples)
          return isES
            ? `• ${plan.consultation_limit ?? 0} consultas al mes\n• Análisis de documentos incluido\n• Mensajes ilimitados`
            : `• ${plan.consultation_limit ?? 0} consultas por mês\n• Análise de documentos incluída\n• Mensagens ilimitadas`;
        }
      }
    } catch (error) {
      this.logger.error(`Erro ao buscar limites do plano ${planName}:`, error);
      throw error;
    }
  }

  private async detectPlanFromMessage(userMessage: string, jurisdiction?: string): Promise<string | null> {
    try {
      this.logger.log('📋 Detectando plano da mensagem com IA:', userMessage);
      
      // Usar IA para detectar plano
      const planAnalysis = await this.aiService.detectPlanFromMessage(userMessage);
      
      if (planAnalysis.planName && planAnalysis.confidence > 0.6) {
        this.logger.log('🤖 Plano detectado pela IA:', planAnalysis);
        return planAnalysis.planName;
      }
      
      // Fallback para detecção manual
      const plans = await this.getUpgradePlans(jurisdiction);
      const lowerMessage = userMessage.toLowerCase();
      
      const selectedPlan = plans.find(plan => 
        lowerMessage.includes(plan.name.toLowerCase())
      );
      
      return selectedPlan ? selectedPlan.name : null;
    } catch (error) {
      this.logger.error('❌ Erro ao detectar plano da mensagem:', error);
      return null;
    }
  }

  async handleWebhook(webhookData: any): Promise<void> {
    try {

      if (webhookData.event === 'messages.upsert') {
        // Verificar se data é array ou objeto único
        const messages = Array.isArray(webhookData.data) ? webhookData.data : [webhookData.data];
        this.logger.log('📨 Processando mensagens:', messages.length);
        
        for (const message of messages) {
          if (message) {
            console.log('📨 Processando mensagem:', JSON.stringify(message, null, 2));
            // Bloquear Evolution para PT/ES quando Cloud estiver ativo
            try {
              const flagEnabledIberia = String(this.configService.get('USE_CLOUD_API_PT_ES') || '').toLowerCase() === 'true';
              const flagEnabledBR = String(this.configService.get('USE_CLOUD_API_BR') || '').toLowerCase() === 'true';
              const remoteJid = message?.key?.remoteJid as string | undefined;
              const phone = remoteJid ? remoteJid.replace('@s.whatsapp.net', '') : undefined;
              const j = phone ? this.jurisdictionService.detectJurisdiction(phone).jurisdiction : undefined;
              if ((flagEnabledIberia && (j === 'PT' || j === 'ES')) || (flagEnabledBR && j === 'BR')) {
                this.logger.log(`⛔ Ignorando evento Evolution para ${phone} (${j}) porque Cloud está ativo.`);
                continue;
              }
            } catch {}
            await this.processMessage(message);
          }
        }
      } else {
        this.logger.warn('⚠️ Evento não suportado:', webhookData.event);
      }
    } catch (error) {
      this.logger.error('Erro ao processar webhook:', error);
      throw error;
    }
  }

  async handleCloudWebhook(payload: any): Promise<void> {
    try {
      const flagEnabledIberia = String(this.configService.get('USE_CLOUD_API_PT_ES') || '').toLowerCase() === 'true';
      const flagEnabledBR = String(this.configService.get('USE_CLOUD_API_BR') || '').toLowerCase() === 'true';
      const cloudEnabled = flagEnabledIberia || flagEnabledBR;
      if (!cloudEnabled) {
        this.logger.warn('Cloud API desabilitada por flag. Ignorando payload.');
        return;
      }

      // Tentar extrair conversationId do payload de statuses (se presente) e persistir no estado/backfill
      try {
        const statuses = payload?.entry?.[0]?.changes?.[0]?.value?.statuses || [];
        for (const st of statuses) {
          const convId = st?.conversation?.id;
          const recipient = st?.recipient_id; // wa_id do usuário
          if (convId && recipient) {
            const phone = String(recipient);
            const prev = this.getConversationState(phone);
            this.setConversationState(phone, { ...prev, conversationId: convId });
            try {
              // Evitar consultas à base local (Prisma) no fluxo BR
              const j = this.jurisdictionService.detectJurisdiction(phone).jurisdiction;
              if (j !== 'BR') {
                // Backfill para mensagens recentes sem conversationId (PT/ES apenas)
                await this.messagingLog.backfillConversationId({ phone, conversationId: convId, sinceMinutes: 180 });
              }
            } catch {}
          }
        }
      } catch {}

      const messages = CloudWebhookAdapter.extractMessages(payload);
      for (const msg of messages) {
        if (this.hasProcessedMessage(msg.messageId)) {
          this.logger.log(`🔁 Mensagem Cloud já processada, ignorando: ${msg.messageId}`);
          continue;
        }
        this.markMessageProcessed(msg.messageId);
        const phone = msg.from; // wa_id
        let jurisdictionInfo = this.jurisdictionService.detectJurisdiction(phone);
        if (this.testNumbersForESFlow.includes(phone)) {
          jurisdictionInfo = { ...jurisdictionInfo, jurisdiction: 'ES', isForced: true } as any;
        }

        // Persistir jurisdição/ddi no estado para roteamento correto nas respostas
        this.setConversationState(phone, {
          jurisdiction: jurisdictionInfo.jurisdiction,
          ddi: jurisdictionInfo.ddi,
          conversationId: this.getConversationState(phone).conversationId,
          // Marcar transporte Cloud para forçar respostas pela API Oficial
          isCloudTransport: true,
        });

        // Alinhar comportamento: se está em análise (ES/PT), seguir as mesmas regras do processSpanishMessage/processPortugueseMessage
        const currentState = this.getConversationState(phone);
        if (currentState.isInAnalysis) {
          // Verificar timeout
          if (this.checkAnalysisTimeout(currentState)) {
            await this.sendMessageWithTyping(phone, this.getAnalysisTimeoutMessage(jurisdictionInfo.jurisdiction), 1500);
            this.setConversationState(phone, { ...currentState, isInAnalysis: false, analysisStartTime: undefined });
            continue;
          }

          if (msg.media.kind === 'document') {
            await this.handleCloudDocumentByMediaId(phone, msg.media.mediaId, jurisdictionInfo.jurisdiction);
            continue;
          }

          if (msg.media.kind === 'text') {
            const tmpMsg = { message: { conversation: (msg as any).media?.text || '' } } as any;
            if (await this.isConfirmationMessage(tmpMsg, jurisdictionInfo.jurisdiction)) {
              await this.handleAnalysisConfirmation(tmpMsg, phone, null, jurisdictionInfo.jurisdiction);
              continue;
            }
            await this.handleTextDuringAnalysis(phone, jurisdictionInfo.jurisdiction);
            continue;
          }

          // Outros tipos durante análise: ignorar
          continue;
        }

        const isBR = jurisdictionInfo.jurisdiction === 'BR';
        switch (msg.media.kind) {
          case 'text': {
            // Aplicar o mesmo gating do Evolution e processar texto diretamente
            const state = this.getConversationState(phone);
            const user = await this.usersService.getOrCreateUser(phone, jurisdictionInfo.jurisdiction);
            if (!user || !user.is_registered) {
              await this.handleUnregisteredUser(phone, msg.media.text, state, jurisdictionInfo, isBR);
              break;
            }
            const sessionResult = isBR
              ? await this.checkBrazilianUserSession(phone)
              : await this.checkWhatsAppSession(phone, jurisdictionInfo.jurisdiction);
            if (!sessionResult.session) {
              if (isBR) {
                await this.handleBrazilianUserWelcome(phone, msg.media.text, state);
              } else {
                await this.handleWhatsAppUserWelcome(phone, msg.media.text, state, jurisdictionInfo);
              }
              break;
            }
            if (sessionResult.needsWelcomeBack) {
              if (isBR) {
                await this.handleWelcomeBackMessage(phone, sessionResult.session);
              } else {
                await this.handleWhatsAppWelcomeBackMessage(phone, sessionResult.session, jurisdictionInfo.jurisdiction);
              }
            }
            if (isBR) {
              await this.updateLastMessageSent(phone);
            } else {
              await this.updateWhatsAppLastMessageSent(phone, jurisdictionInfo.jurisdiction);
            }
            await this.handleTextMessage(msg.media.text, user, phone, state, jurisdictionInfo.jurisdiction);
            break;
          }
          case 'audio': {
            // Pré-fluxo igual ao Evolution (PT/ES)
            const state = this.getConversationState(phone);
            const user = await this.usersService.getOrCreateUser(phone, jurisdictionInfo.jurisdiction);
            if (!user || !user.is_registered) {
              await this.handleUnregisteredUser(phone, '', state, jurisdictionInfo, isBR);
              break;
            }
            const sessionResult = isBR
              ? await this.checkBrazilianUserSession(phone)
              : await this.checkWhatsAppSession(phone, jurisdictionInfo.jurisdiction);
            if (!sessionResult.session) {
              if (isBR) {
                await this.handleBrazilianUserWelcome(phone, '', state);
              } else {
                await this.handleWhatsAppUserWelcome(phone, '', state, jurisdictionInfo);
              }
              break;
            }
            if (sessionResult.needsWelcomeBack) {
              if (isBR) {
                await this.handleWelcomeBackMessage(phone, sessionResult.session);
              } else {
                await this.handleWhatsAppWelcomeBackMessage(phone, sessionResult.session, jurisdictionInfo.jurisdiction);
              }
            }
            if (isBR) {
              await this.updateLastMessageSent(phone);
            } else {
              await this.updateWhatsAppLastMessageSent(phone, jurisdictionInfo.jurisdiction);
            }
            await this.handleCloudAudioByMediaId(phone, msg.media.mediaId, jurisdictionInfo.jurisdiction);
            break;
          }
          case 'document': {
            const state = this.getConversationState(phone);
            const user = await this.usersService.getOrCreateUser(phone, jurisdictionInfo.jurisdiction);
            if (!user || !user.is_registered) {
              await this.handleUnregisteredUser(phone, '', state, jurisdictionInfo, isBR);
              break;
            }
            const sessionResult = isBR
              ? await this.checkBrazilianUserSession(phone)
              : await this.checkWhatsAppSession(phone, jurisdictionInfo.jurisdiction);
            if (!sessionResult.session) {
              if (isBR) {
                await this.handleBrazilianUserWelcome(phone, '', state);
              } else {
                await this.handleWhatsAppUserWelcome(phone, '', state, jurisdictionInfo);
              }
              break;
            }
            if (sessionResult.needsWelcomeBack) {
              if (isBR) {
                await this.handleWelcomeBackMessage(phone, sessionResult.session);
              } else {
                await this.handleWhatsAppWelcomeBackMessage(phone, sessionResult.session, jurisdictionInfo.jurisdiction);
              }
            }
            if (isBR) {
              await this.updateLastMessageSent(phone);
            } else {
              await this.updateWhatsAppLastMessageSent(phone, jurisdictionInfo.jurisdiction);
            }
            await this.handleCloudDocumentByMediaId(phone, msg.media.mediaId, jurisdictionInfo.jurisdiction);
            break;
          }
          case 'image': {
            const state = this.getConversationState(phone);
            const user = await this.usersService.getOrCreateUser(phone, jurisdictionInfo.jurisdiction);
            if (!user || !user.is_registered) {
              await this.handleUnregisteredUser(phone, '', state, jurisdictionInfo, isBR);
              break;
            }
            const sessionResult = isBR
              ? await this.checkBrazilianUserSession(phone)
              : await this.checkWhatsAppSession(phone, jurisdictionInfo.jurisdiction);
            if (!sessionResult.session) {
              if (isBR) {
                await this.handleBrazilianUserWelcome(phone, '', state);
              } else {
                await this.handleWhatsAppUserWelcome(phone, '', state, jurisdictionInfo);
              }
              break;
            }
            if (sessionResult.needsWelcomeBack) {
              if (isBR) {
                await this.handleWelcomeBackMessage(phone, sessionResult.session);
              } else {
                await this.handleWhatsAppWelcomeBackMessage(phone, sessionResult.session, jurisdictionInfo.jurisdiction);
              }
            }
            if (isBR) {
              await this.updateLastMessageSent(phone);
            } else {
              await this.updateWhatsAppLastMessageSent(phone, jurisdictionInfo.jurisdiction);
            }
            await this.handleCloudImageByMediaId(phone, msg.media.mediaId, jurisdictionInfo.jurisdiction);
            break;
          }
          default:
            break;
        }
      }
    } catch (error) {
      this.logger.error('Erro ao processar webhook (Cloud):', error);
      throw error;
    }
  }

  private async handleCloudAudioByMediaId(phone: string, mediaId: string, forcedJurisdiction: string): Promise<void> {
    try {
      this.logger.log('🎵 (Cloud) Baixando áudio por mediaId...');
      const audioBuffer = await this.cloudMedia.downloadMediaById(mediaId);
      const normalizedBuffer = await this.audioProcessor.convertToMp3WithFallback(audioBuffer);
      const user = await this.usersService.getOrCreateUser(phone, forcedJurisdiction);
      await this.processAudioBinary(normalizedBuffer, { phone, user, jurisdiction: forcedJurisdiction });
    } catch (error) {
      this.logger.error('❌ Erro (Cloud) ao processar áudio:', error);
      await this.sendMessage(phone, forcedJurisdiction === 'ES' ? '❌ Error al procesar el audio. Inténtalo de nuevo.' : '❌ Erro ao processar o áudio. Tente novamente.');
    }
  }

  private async handleCloudDocumentByMediaId(phone: string, mediaId: string, forcedJurisdiction: string): Promise<void> {
    try {
      this.logger.log('📄 (Cloud) Baixando documento por mediaId...');
      const documentBuffer = await this.cloudMedia.downloadMediaById(mediaId);
      const user = await this.usersService.getOrCreateUser(phone, forcedJurisdiction);
      await this.processDocumentBinary(documentBuffer, { phone, user, jurisdiction: forcedJurisdiction });
    } catch (error) {
      this.logger.error('❌ Erro (Cloud) ao processar documento:', error);
      const retryMsg = this.getLocalizedErrorMessage('document_analysis_failed', forcedJurisdiction);
      await this.sendMessage(phone, retryMsg);
    }
  }

  private async handleCloudImageByMediaId(phone: string, mediaId: string, forcedJurisdiction: string): Promise<void> {
    try {
      this.logger.log('🖼️ (Cloud) Baixando imagem por mediaId...');
      const imageBuffer = await this.cloudMedia.downloadMediaById(mediaId);
      const user = await this.usersService.getOrCreateUser(phone, forcedJurisdiction);
      await this.processImageBinary(imageBuffer, { phone, user, jurisdiction: forcedJurisdiction });
    } catch (error) {
      this.logger.error('❌ Erro (Cloud) ao processar imagem:', error);
      await this.sendMessage(phone, '❌ Erro ao analisar a imagem. Tente novamente.');
    }
  }

  private async handleUnregisteredUser(
    phone: string, 
    text: string, 
    state: ConversationState, 
    jurisdiction: any, 
    isBrazilianUser: boolean
  ): Promise<void> {
    try {
      // Se é usuário brasileiro, enviar link para cadastro no site
      if (isBrazilianUser) {
        const response = `🇧🇷 Olá! Seja bem-vindo ao Chat LawX!\n\nPara usuários brasileiros, você precisa se cadastrar em nossa plataforma web.\n\n🔗 Acesse: https://plataforma.lawx.ai/auth/signup\n\nApós o cadastro, você poderá usar nosso assistente jurídico via WhatsApp.\n\nSe já possui cadastro, verifique se seu número está vinculado à sua conta.`;
        await this.sendMessageWithTyping(phone, response, 2000);
        return;
      }
      
      // Para PT/ES, usar fluxo de boas-vindas WhatsApp (com IA localizada)
      // Em vez de fluxo de cadastro estático, usar handleWhatsAppUserWelcome
      await this.handleWhatsAppUserWelcome(phone, text, state, jurisdiction);
      return;

    } catch (error) {
      this.logger.error('Erro no fluxo de cadastro:', error);
      await this.sendMessage(phone, '❌ Ocorreu um erro durante o cadastro. Tente novamente mais tarde.');
    }
  }

  private async finalizeUserRegistration(
    phone: string, 
    state: ConversationState, 
    jurisdiction: any
  ): Promise<void> {
    try {
      // Criar usuário
      const user = await this.usersService.registerUserWithLegalInfo(
        phone,
        state.pendingName!,
        state.pendingEmail!,
        jurisdiction.jurisdiction,
        jurisdiction.ddi
      );

      // Criar assinatura Fremium automaticamente
      await this.subscriptionsService.createFremiumSubscription(user.id);

      // Mensagem de boas-vindas
      const response = `🎉 Parabéns, ${state.pendingName}!\n\n✅ Seu cadastro foi realizado com sucesso!\n\n🎁 Você recebeu automaticamente o plano *Fremium* com:\n• 2 consultas jurídicas gratuitas\n• Análise de documentos básica\n\n💬 Agora você pode:\n• Fazer perguntas sobre direito\n• Enviar documentos para análise\n• Solicitar orientações jurídicas\n\nDigite "MENU" para ver todas as opções disponíveis.`;
      
      await this.sendMessageWithTyping(phone, response, 2500);
      
      // Limpar estado da conversa
      this.clearConversationState(phone);
      
      this.logger.log(`✅ Usuário ${phone} cadastrado com sucesso com plano Fremium`);

    } catch (error) {
      this.logger.error('Erro ao finalizar cadastro:', error);
      await this.sendMessage(phone, '❌ Erro ao finalizar cadastro. Tente novamente mais tarde.');
    }
  }

  // ===== MÉTODOS PARA USUÁRIOS BRASILEIROS =====

  private async checkBrazilianUserSession(phone: string): Promise<{
    session: any | null;
    needsWelcomeBack: boolean;
    timeSinceLastMessage: number;
  }> {
    try {
      return await this.sessionService.checkBrazilianUserSession(phone);
    } catch (error) {
      this.logger.error(`❌ Erro ao verificar sessão brasileira ${phone}:`, error);
      return { session: null, needsWelcomeBack: false, timeSinceLastMessage: 0 };
    }
  }

  private async handleWelcomeBackMessage(phone: string, session: any): Promise<void> {
    try {
      const message = `Bem vindo novamente ${session.name}, em que posso te ajudar?`;
      await this.sendMessageWithTyping(phone, message, 1500);
      
      // Atualizar last_message_sent
      await this.updateLastMessageSent(phone);
      
      this.logger.log(`👋 Mensagem de boas-vindas enviada para ${session.name}`);
    } catch (error) {
      this.logger.error(`❌ Erro ao enviar mensagem de boas-vindas para ${phone}:`, error);
    }
  }

  private async updateLastMessageSent(phone: string): Promise<void> {
    try {
      await this.sessionService.updateBrazilLastMessageSent(phone);
    } catch (error) {
      this.logger.error(`❌ Erro ao atualizar last_message_sent para ${phone}:`, error);
    }
  }

  // ===== MÉTODOS PARA CONTROLE DE SESSÃO WHATSAPP (ES/PT) =====

  /**
   * Verifica se usuário tem sessão ativa no WhatsApp (ES/PT)
   * Equivalente ao checkBrazilianUserSession mas usando Prisma
   */
  private async checkWhatsAppSession(phone: string, jurisdiction: string): Promise<{
    session: any | null;
    needsWelcomeBack: boolean;
    timeSinceLastMessage: number;
  }> {
    try {
      return await this.sessionService.checkWhatsAppSession(phone, jurisdiction);
    } catch (error) {
      this.logger.error(`❌ Erro ao verificar sessão WhatsApp para ${phone}:`, error);
      return { session: null, needsWelcomeBack: false, timeSinceLastMessage: 0 };
    }
  }

  /**
   * Cria nova sessão WhatsApp (ES/PT)
   * Equivalente ao createBrazilianUserSession mas usando Prisma
   */
  private async createWhatsAppSession(phone: string, name: string, jurisdiction: string): Promise<any> {
    try {
      this.logger.log(`📝 Criando sessão WhatsApp: ${name} - ${phone} (${jurisdiction})`);
      const session = await this.sessionService.createWhatsAppSession(phone, name, jurisdiction);
      this.logger.log(`✅ Sessão WhatsApp criada com sucesso: ${session.id}`);
      return session;
    } catch (error) {
      this.logger.error(`❌ Erro ao criar sessão WhatsApp para ${phone}:`, error);
      throw error;
    }
  }

  /**
   * Atualiza timestamp da última mensagem (ES/PT)
   * Equivalente ao updateLastMessageSent mas usando Prisma
   */
  private async updateWhatsAppLastMessageSent(phone: string, jurisdiction: string): Promise<void> {
    try {
      await this.sessionService.updateWhatsAppLastMessageSent(phone);
      this.logger.log(`✅ Campo lastMessageSent atualizado para ${phone}`);
    } catch (error) {
      this.logger.error(`❌ Erro ao atualizar lastMessageSent para ${phone}:`, error);
    }
  }

  /**
   * Manipula boas-vindas para usuários WhatsApp (ES/PT)
   * Equivalente ao handleBrazilianUserWelcome mas adaptado para ES/PT
   */
  private async handleWhatsAppUserWelcome(
    phone: string, 
    text: string, 
    state: ConversationState,
    jurisdiction: any
  ): Promise<void> {
    try {
      // Proteção contra duplicidade: se outro caminho já marcou o estado para coletar nome,
      // evitar reenviar a mesma dupla de mensagens no mesmo ciclo de processamento.
      const freshState = this.getConversationState(phone);
      if (freshState.isWaitingForWhatsAppName && !state.isWaitingForWhatsAppName) {
        return;
      }

      // Se já está no fluxo de coleta de nome
      if (freshState.isWaitingForWhatsAppName) {
        // Usuário já enviou o nome
        if (text.length < 2) {
          const response = jurisdiction.jurisdiction === 'ES' 
            ? '❌ Por favor, proporciona un nombre válido con al menos 2 caracteres.'
            : '❌ Por favor, forneça um nome válido com pelo menos 2 caracteres.';

          await this.sendMessageWithTyping(phone, response, 1000);
          return;
        }

        // Criar sessão na tabela whatsapp_sessions
        await this.createWhatsAppSession(phone, text, jurisdiction.jurisdiction);
        
        // Gerar mensagem de boas-vindas personalizada com IA
        const welcomePrompt = `Gere uma mensagem de boas-vindas personalizada para o Chat LawX, um assistente jurídico especializado.

Nome do usuário: ${text}
Jurisdição: ${getJurisdiction(jurisdiction.jurisdiction)}
Idioma: ${getJurisdictionLanguage(jurisdiction.jurisdiction)}

Use obrigatoriamente no idioma ${getJurisdictionLanguage(jurisdiction.jurisdiction)} para responder.

Estrutura a ser usada na resposta:

Olá, ${text}!

Você pode falar comigo por áudio ou por texto!

Algumas das minhas funcionalidades:

✅ Responder dúvidas jurídicas
✅ Análise de documentos PDF/DOCX
✅ Análise de imagens

Como posso te ajudar hoje?`;

        const welcomeMsg = await this.aiGateway.executeCustomPrompt(
          welcomePrompt,
          'gpt-4o-mini',
          'Você é um especialista em criar mensagens de boas-vindas personalizadas para assistentes jurídicos. Seja profissional e útil.',
          0.7,
          300
        );
        
        // Enviar mensagem de boas-vindas personalizada
        await this.sendMessageWithTyping(phone, welcomeMsg, 2000);
        
        // Limpar estado da conversa
        this.clearConversationState(phone);
        
        this.logger.log(`✅ Usuário ${jurisdiction.jurisdiction} ${phone} iniciou sessão com nome: ${text}`);
        return;
      }

      // Primeira mensagem - gerar boas-vindas personalizada com IA
      const welcomePrompt = `Gere uma mensagem de boas-vindas personalizada para o Chat LawX, um assistente jurídico especializado.

Jurisdição: ${jurisdiction.jurisdiction === 'ES' ? 'Espanha' : 'Portugal'}
Idioma: ${jurisdiction.jurisdiction === 'ES' ? 'Espanhol' : 'Português europeu'}

Requisitos:
- Deve mencionar obrigatoriamente "Chat LawX"
- Deve especificar que é um assistente jurídico
- Deve ser adequado para a jurisdição ${jurisdiction.jurisdiction}
- Tom amigável e profissional
- Máximo 5 linhas
- Use emojis apropriados
- NÃO inclua pergunta sobre nome (será enviada separadamente)

Exemplo de estrutura:
[Emoji] [Saudação] Chat LawX!
[Emoji] Sou teu assistente jurídico especializado em [jurisdição].
[Emoji] [Mensagem de boas-vindas]`;

      const welcomeMsg = await this.aiGateway.executeCustomPrompt(
        welcomePrompt,
        'gpt-4o-mini',
        'Você é um especialista em criar mensagens de boas-vindas para assistentes jurídicos. Seja conciso e profissional.',
        0.7,
        300
      );

      // Segunda mensagem - pergunta sobre nome
      const nameQuestion = jurisdiction.jurisdiction === 'ES' 
        ? '📝 ¿Cuál es tu nombre?'
        : '📝 Qual é o teu nome?';
      
      // Enviar primeira mensagem
      await this.sendMessageWithTyping(phone, welcomeMsg, 2000);
      
      // Aguardar 2 segundos antes de enviar a pergunta sobre nome
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Enviar segunda mensagem
      await this.sendMessageWithTyping(phone, nameQuestion, 1000);
      
      // Atualizar estado da conversa
      this.setConversationState(phone, {
        ...freshState,
        isWaitingForWhatsAppName: true
      });
      
    } catch (error) {
      this.logger.error('Erro no fluxo de boas-vindas WhatsApp:', error);
      const errorMessage = jurisdiction.jurisdiction === 'ES'
        ? '❌ Ocurrió un error. Inténtalo de nuevo más tarde.'
        : '❌ Ocorreu um erro. Tente novamente mais tarde.';
      await this.sendMessage(phone, errorMessage);
    }
  }

  /**
   * Manipula mensagem de boas-vindas para retorno (ES/PT)
   * Equivalente ao handleWelcomeBackMessage mas adaptado para ES/PT
   */
  private async handleWhatsAppWelcomeBackMessage(phone: string, session: any, jurisdiction: string): Promise<void> {
    try {
      let message = '';
      if (jurisdiction === 'ES') {
        message = `Bienvenido de nuevo ${session.name}, ¿en qué puedo ayudarte?`;
      } else {
        message = `Bem-vindo novamente ${session.name}, em que posso ajudá-lo?`;
      }
      
      await this.sendMessage(phone, message);
      
      // Atualizar lastMessageSent
      await this.updateWhatsAppLastMessageSent(phone, jurisdiction);
      
      this.logger.log(`👋 Mensagem de boas-vindas enviada para ${session.name} (${jurisdiction})`);
    } catch (error) {
      this.logger.error(`❌ Erro ao enviar mensagem de boas-vindas para ${phone}:`, error);
    }
  }

  private async createBrazilianUserSession(phone: string, name: string): Promise<any> {
    try {
      this.logger.log(`📝 Criando sessão brasileira: ${name} - ${phone}`);
      const data = await this.sessionService.createBrazilianUserSession(phone, name);
      this.logger.log(`✅ Sessão criada com sucesso: ${data.id}`);
      return data;
    } catch (error) {
      this.logger.error(`❌ Erro ao criar sessão brasileira ${phone}:`, error);
      throw error;
    }
  }

  private async handleBrazilianUserWelcome(
    phone: string, 
    text: string, 
    state: ConversationState
  ): Promise<void> {
    try {
      // Verificar se já está no fluxo de coleta de nome
      if (state.isWaitingForBrazilianName) {
        // Usuário já enviou o nome
        if (text.length < 2) {
          await this.sendMessageWithTyping(phone, '❌ Por favor, informe um nome válido com pelo menos 2 caracteres.', 1000);
          return;
        }

        // Criar sessão na tabela atendimento_wpps
        await this.createBrazilianUserSession(phone, text);
        
        // Mensagem de boas-vindas
        const response = `🎉 Olá, ${text}! Seja bem-vindo ao Chat LawX!\n\n🇧🇷 Sou seu assistente jurídico especializado em legislação brasileira.\n\n💬 Como posso ajudá-lo hoje?\n\nVocê pode:\n• Fazer perguntas sobre direito\n• Enviar documentos para análise\n• Solicitar orientações jurídicas\n\nDigite "MENU" para ver todas as opções disponíveis.`;
        
        await this.sendMessageWithTyping(phone, response, 2000);
        
        // Limpar estado da conversa
        this.clearConversationState(phone);
        
        this.logger.log(`✅ Usuário brasileiro ${phone} iniciou sessão com nome: ${text}`);
        return;
      }

      // Primeira mensagem - enviar boas-vindas e solicitar nome
      const response = `🇧🇷 Olá! Seja bem-vindo ao Chat LawX!\n\nSou seu assistente jurídico especializado em legislação brasileira.\n\nPara personalizar seu atendimento, preciso saber seu nome.\n\n📝 Qual é o seu nome completo?`;
      
      await this.sendMessageWithTyping(phone, response, 2000);
      
      // Atualizar estado da conversa
      this.setConversationState(phone, {
        ...state,
        isWaitingForBrazilianName: true
      });
      
    } catch (error) {
      this.logger.error('Erro no fluxo de boas-vindas brasileiro:', error);
      await this.sendMessage(phone, '❌ Ocorreu um erro. Tente novamente mais tarde.');
    }
  }

  private async processMessage(message: any): Promise<void> {
    try {
      if (!message.key?.remoteJid) {
        return;
      }
      
      const phone = message.key.remoteJid.replace('@s.whatsapp.net', '');
      const isFromMe = message.key.fromMe;
      
      if (isFromMe) {
        return;
      }

      // Detectar jurisdição baseada no número de telefone
      let jurisdiction = this.jurisdictionService.detectJurisdiction(phone);
      
        // 🧪 TESTE: Verificar se o número está no array de teste para forçar fluxo ES
        if (this.testNumbersForESFlow.includes(phone)) {
          this.logger.log(`🧪 NÚMERO DE TESTE DETECTADO: ${phone} - Forçando fluxo ES`);
          jurisdiction = {
            jurisdiction: 'ES',
            ddi: '34',
            country: 'Spain',
            isValid: true,
            config: jurisdiction.config, // Manter a configuração original
            isForced: true // Marcar como forçada para evitar sobrescrita
          };
        }
      
      this.logger.log(`Jurisdição detectada: ${jurisdiction.jurisdiction} para ${phone}`);

      // Extrair texto da mensagem
      const text = message.message?.conversation || '';
      const state = this.getConversationState(phone);
      this.logger.log('💬 Estado da conversa:', JSON.stringify(state, null, 2));

      // Persistir jurisdição detectada/forçada no estado da conversa
      // para que etapas subsequentes (ex.: seleção de plano/frequência)
      // não recaiam para BR ao redetectar pelo número brasileiro de teste
      this.setConversationState(phone, {
        jurisdiction: jurisdiction.jurisdiction,
        ddi: jurisdiction.ddi,
      });

      // Roteamento por jurisdição usando Strategy
      const handler = this.jurisdictionRouter.resolve(jurisdiction.jurisdiction);
      await handler.process(
        message,
        phone,
        text,
        state,
        jurisdiction,
        {
          processBrazilianMessage: (m, p, t, s, j) => this.processBrazilianMessage(m, p, t, s, j),
          processPortugueseMessage: (m, p, t, s, j) => this.processPortugueseMessage(m, p, t, s, j),
          processSpanishMessage: (m, p, t, s, j) => this.processSpanishMessage(m, p, t, s, j),
        }
      );
    } catch (error) {
      this.logger.error('Erro ao processar mensagem:', error);
    }
  }

  private async processBrazilianMessage(message: any, phone: string, text: string, state: ConversationState, jurisdiction: any): Promise<void> {
    try {
      this.logger.log('🇧🇷 Processando mensagem de usuário brasileiro...');
      
      // Buscar usuário no Supabase (tabela profiles)
      const user = await this.usersService.getOrCreateUser(phone);
      
      // Verificar se usuário não está registrado
      if (!user || !user.is_registered) {
        await this.handleUnregisteredUser(phone, text, state, jurisdiction, true);
        return;
      }

      // Verificar se usuário tem sessão ativa na tabela atendimento_wpps
      const sessionResult = await this.checkBrazilianUserSession(phone);
      
      if (!sessionResult.session) {
        // Usuário não tem sessão ativa - iniciar fluxo de boas-vindas
        await this.handleBrazilianUserWelcome(phone, text, state);
        return;
      }
      
      // Usuário tem sessão ativa - verificar se precisa de mensagem de boas-vindas
      if (sessionResult.needsWelcomeBack) {
        // Usuário tem sessão mas passou 1 hora - enviar mensagem de boas-vindas
        await this.handleWelcomeBackMessage(phone, sessionResult.session);
        // Continuar processamento normal após mensagem
      } else {
        this.logger.log(`✅ Usuário brasileiro com sessão ativa: ${sessionResult.session.name}`);
      }
      
      // Atualizar last_message_sent para esta interação
      await this.updateLastMessageSent(phone);

      // PRIMEIRO: Verificar se está em análise de documento
      if (state.isInAnalysis) {
        // Verificar timeout (10 minutos)
        if (this.checkAnalysisTimeout(state)) {
          await this.sendMessageWithTyping(phone, this.getAnalysisTimeoutMessage('BR'), 1500);
          this.setConversationState(phone, { ...state, isInAnalysis: false, analysisStartTime: undefined });
          return;
        }

        // Se está em análise, processar confirmações ou documentos
        if (await this.isConfirmationMessage(message, 'BR')) {
          await this.handleAnalysisConfirmation(message, phone, null, 'BR');
          return;
        }
        
        if (message.message?.documentMessage) {
          // Processar documento normalmente (mantém isInAnalysis = true)
          await this.handleDocumentMessage(message, null, phone);
          return;
        }
        
        // Para textos durante análise: avisar que só aceita PDF/DOCX
        if (message.message?.textMessage) {
          await this.handleTextDuringAnalysis(phone, 'BR');
          return;
        }
        
        // Ignorar outras mensagens
        return;
      }

      // Processar por tipo de mídia
      if (message.message?.imageMessage) {
        this.logger.log('🖼️ Processando imagem jurídica (BR)');
        await this.handleImageMessage(message, user, phone);
        return;
      }

      if (message.message?.audioMessage) {
        this.logger.log('🎵 Processando áudio jurídico (BR)');
        await this.handleAudioMessage(message, user, phone);
        return;
      }

      if (message.message?.documentMessage) {
        this.logger.log('📄 Processando documento jurídico (BR)');
        await this.handleDocumentMessage(message, user, phone, jurisdiction.jurisdiction);
        return;
      }

      // Processar texto - fluxo específico para usuários brasileiros registrados
      this.logger.log('📝 Processando texto jurídico (BR)');
      await this.handleTextMessage(text, user, phone, state);
      
    } catch (error) {
      this.logger.error('Erro ao processar mensagem brasileira:', error);
      await this.sendMessage(phone, '❌ Ocorreu um erro ao processar sua mensagem. Tente novamente.');
    }
  }

  private async processPortugueseMessage(message: any, phone: string, text: string, state: ConversationState, jurisdiction: any): Promise<void> {
    try {
      this.logger.log('🇵🇹 Processando mensagem de usuário português...');
      
      // 🔒 PRESERVAR JURISDIÇÃO FORÇADA: Se foi forçada para teste, manter durante todo o fluxo
      if (jurisdiction.isForced) {
        this.logger.log(`🔒 Mantendo jurisdição forçada: ${jurisdiction.jurisdiction} para ${phone}`);
      }

      // ✅ PRIMEIRO: Verificar se está no fluxo de coleta de nome
      if (state.isWaitingForWhatsAppName) {
        await this.handleWhatsAppUserWelcome(phone, text, state, jurisdiction);
        return;
      }

      // Buscar ou criar usuário local com jurisdição forçada
      const user = await this.usersService.getOrCreateUser(phone, jurisdiction.jurisdiction);
      
      // Verificar se usuário não está registrado
      if (!user || !user.is_registered) {
        await this.handleUnregisteredUser(phone, text, state, jurisdiction, false);
        return;
      }

      // ✅ NOVO: Verificar se usuário tem sessão ativa na tabela whatsapp_sessions
      const sessionResult = await this.checkWhatsAppSession(phone, jurisdiction.jurisdiction);
      
      if (!sessionResult.session) {
        // Usuário não tem sessão ativa - iniciar fluxo de boas-vindas
        await this.handleWhatsAppUserWelcome(phone, text, state, jurisdiction);
        return;
      }
      
      // ✅ NOVO: Usuário tem sessão ativa - verificar se precisa de mensagem de boas-vindas
      if (sessionResult.needsWelcomeBack) {
        // Usuário tem sessão mas passou 1 hora - enviar mensagem de boas-vindas
        await this.handleWhatsAppWelcomeBackMessage(phone, sessionResult.session, jurisdiction.jurisdiction);
        // Continuar processamento normal após mensagem
      } else {
        this.logger.log(`✅ Usuário português com sessão ativa: ${sessionResult.session.name}`);
      }
      
      // ✅ NOVO: Atualizar lastMessageSent para esta interação
      await this.updateWhatsAppLastMessageSent(phone, jurisdiction.jurisdiction);

      // PRIMEIRO: Verificar se está em análise de documento
      if (state.isInAnalysis) {
        // Verificar timeout (10 minutos)
        if (this.checkAnalysisTimeout(state)) {
          await this.sendMessageWithTyping(phone, this.getAnalysisTimeoutMessage('PT'), 1500);
          this.setConversationState(phone, { ...state, isInAnalysis: false, analysisStartTime: undefined });
          return;
        }

        // Se está em análise, processar confirmações ou documentos
        if (await this.isConfirmationMessage(message, 'PT')) {
          await this.handleAnalysisConfirmation(message, phone, null, 'PT');
          return;
        }
        
        if (message.message?.documentMessage) {
          // Processar documento normalmente (mantém isInAnalysis = true)
          await this.handleDocumentMessage(message, null, phone);
          return;
        }
        
        // Para textos durante análise: avisar que só aceita PDF/DOCX
        if (message.message?.textMessage) {
          await this.handleTextDuringAnalysis(phone, 'PT');
          return;
        }
        
        // Ignorar outras mensagens
        return;
      }

      // Processar por tipo de mídia
      if (message.message?.imageMessage) {
        this.logger.log('🖼️ Processando imagem jurídica (PT)');
        await this.handleImageMessage(message, user, phone);
        return;
      }

      if (message.message?.audioMessage) {
        this.logger.log('🎵 Processando áudio jurídico (PT)');
        await this.handleAudioMessage(message, user, phone, jurisdiction.jurisdiction);
        return;
      }

      if (message.message?.documentMessage) {
        this.logger.log('📄 Processando documento jurídico (PT)');
        await this.handleDocumentMessage(message, user, phone, jurisdiction.jurisdiction);
        return;
      }

      // Processar texto
      this.logger.log('📝 Processando texto jurídico (PT)');
      await this.handleTextMessage(text, user, phone, state, jurisdiction.jurisdiction);

    } catch (error) {
      this.logger.error('Erro ao processar mensagem portuguesa:', error);
      await this.sendMessage(phone, '❌ Ocorreu um erro ao processar sua mensagem. Tente novamente.');
    }
  }

  private async processSpanishMessage(message: any, phone: string, text: string, state: ConversationState, jurisdiction: any): Promise<void> {
    try {
      this.logger.log('🇪🇸 Processando mensagem de usuário espanhol...');
      
      // 🔒 PRESERVAR JURISDIÇÃO FORÇADA: Se foi forçada para teste, manter durante todo o fluxo
      if (jurisdiction.isForced) {
        this.logger.log(`🔒 Mantendo jurisdição forçada: ${jurisdiction.jurisdiction} para ${phone}`);
      }

      // ✅ PRIMEIRO: Verificar se está no fluxo de coleta de nome
      if (state.isWaitingForWhatsAppName) {
        await this.handleWhatsAppUserWelcome(phone, text, state, jurisdiction);
        return;
      }

      // Buscar ou criar usuário local com jurisdição forçada
      const user = await this.usersService.getOrCreateUser(phone, jurisdiction.jurisdiction);
      
      // Verificar se usuário não está registrado
      if (!user || !user.is_registered) {
        await this.handleUnregisteredUser(phone, text, state, jurisdiction, false);
        return;
      }

      // ✅ NOVO: Verificar se usuário tem sessão ativa na tabela whatsapp_sessions
      const sessionResult = await this.checkWhatsAppSession(phone, jurisdiction.jurisdiction);
      
      if (!sessionResult.session) {
        // Usuário não tem sessão ativa - iniciar fluxo de boas-vindas
        await this.handleWhatsAppUserWelcome(phone, text, state, jurisdiction);
        return;
      }
      
      // ✅ NOVO: Usuário tem sessão ativa - verificar se precisa de mensagem de boas-vindas
      if (sessionResult.needsWelcomeBack) {
        // Usuário tem sessão mas passou 1 hora - enviar mensagem de boas-vindas
        await this.handleWhatsAppWelcomeBackMessage(phone, sessionResult.session, jurisdiction.jurisdiction);
        // Continuar processamento normal após mensagem
      }
      
      // ✅ NOVO: Atualizar lastMessageSent para esta interação
      await this.updateWhatsAppLastMessageSent(phone, jurisdiction.jurisdiction);

      // PRIMEIRO: Verificar se está em análise de documento
      if (state.isInAnalysis) {
        // Verificar timeout (10 minutos)
        if (this.checkAnalysisTimeout(state)) {
          await this.sendMessageWithTyping(phone, this.getAnalysisTimeoutMessage('ES'), 1500);
          this.setConversationState(phone, { ...state, isInAnalysis: false, analysisStartTime: undefined });
          return;
        }

        // Se está em análise, processar confirmações ou documentos
        if (await this.isConfirmationMessage(message, 'ES')) {
          await this.handleAnalysisConfirmation(message, phone, null, 'ES');
          return;
        }
        
        if (message.message?.documentMessage) {
          // Processar documento normalmente (mantém isInAnalysis = true)
          await this.handleDocumentMessage(message, null, phone);
          return;
        }
        
        // Para textos durante análise: avisar que só aceita PDF/DOCX
        if (message.message?.textMessage) {
          await this.handleTextDuringAnalysis(phone, 'ES');
          return;
        }
        
        // Ignorar outras mensagens
        return;
      }

      // Processar por tipo de mídia
      if (message.message?.imageMessage) {
        this.logger.log('🖼️ Processando imagem jurídica (ES)');
        await this.handleImageMessage(message, user, phone);
        return;
      }

      if (message.message?.audioMessage) {
        this.logger.log('🎵 Processando áudio jurídico (ES)');
        await this.handleAudioMessage(message, user, phone, jurisdiction.jurisdiction);
        return;
      }

      if (message.message?.documentMessage) {
        this.logger.log('📄 Processando documento jurídico (ES)');
        await this.handleDocumentMessage(message, user, phone, jurisdiction.jurisdiction);
        return;
      }

      // Processar texto
      this.logger.log('📝 Processando texto jurídico (ES)');
      await this.handleTextMessage(text, user, phone, state, jurisdiction.jurisdiction);

    } catch (error) {
      this.logger.error('Erro ao processar mensagem espanhola:', error);
      await this.sendMessage(phone, '❌ Ocorreu un error al procesar tu mensaje. Inténtalo de nuevo.');
    }
  }

  private async handleImageMessage(message: any, user: User | null, phone: string): Promise<void> {
    try {
      this.logger.log('📸 Processando mensagem de imagem jurídica...');
      
      // Validar limites para documentos
      if (user?.id) {
        const usageCheck = await this.usageService.checkLimits(user.id, 'document_analysis', phone);
        if (!usageCheck.allowed) {
          await this.handleLimitReachedMessage(phone, user, usageCheck.message, undefined);
          return;
        }
      }
      
      // Download da imagem
      const imageBuffer = await this.downloadImage(message);
      if (!imageBuffer) {
        await this.sendMessage(phone, '❌ Não consegui baixar a imagem. Tente novamente.');
        return;
      }

      await this.processImageBinary(imageBuffer, { phone, user });
      
    } catch (error) {
      this.logger.error('Erro ao processar imagem jurídica:', error);
      await this.sendMessage(phone, '❌ Erro ao analisar o documento. Tente novamente ou envie uma imagem mais clara.');
    }
  }

  private async handleTextMessage(text: string, user: User | null, phone: string, state: ConversationState, forcedJurisdiction?: string): Promise<void> {
    try {
      this.logger.log('📝 Processando mensagem de texto jurídica:', text);

      // 0. Detectar intenção de acessar o menu via IA
      try {
        const menuDetectionPrompt = `
Tarefa: Detectar se a mensagem do usuário indica intenção de abrir o menu.

Responda EXCLUSIVAMENTE com JSON válido, sem markdown, sem texto adicional, sem comentários.

Formato OBRIGATÓRIO (exato):
{"isMenu": true|false}

Critérios (PT-BR, PT-PT e ES, incluindo variações e acentos):
- Palavras e expressões equivalentes a abrir/ver o menu: "menu", "menú", "mostrar menu", "ver menu", "menu por favor"
- Termos relacionados a opções/ajuda: "opções", "opcoes", "opção", "opcao", "opciones", "ajuda", "help"
- Perguntas ou comandos que implicam exibir opções do sistema

Mensagem: "${text.trim()}"`;

        const aiResponse = await this.aiService.executeCustomPrompt(
          menuDetectionPrompt,
          'gpt-4o-mini',
          'Você é um classificador. Responda apenas JSON válido exatamente no formato {"isMenu": true|false}.',
          0.1,
        );

        let parsed: any | null = null;
        try {
          parsed = aiResponse ? JSON.parse(aiResponse.trim()) : null;
        } catch {
          const jsonMatch = aiResponse && aiResponse.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            parsed = JSON.parse(jsonMatch[0]);
          }
        }

        if (parsed && parsed.isMenu === true) {
          await this.showLegalMenu(phone, forcedJurisdiction || 'BR');
          return;
        }
      } catch (menuDetectErr) {
        this.logger.warn('⚠️ Falha ao detectar intenção de menu via IA. Usando fallback simples.', menuDetectErr);
        if (text.toLowerCase().trim() === 'menu') {
          await this.showLegalMenu(phone, forcedJurisdiction || 'BR');
          return;
        }
      }

      // 0.1 Jurisdição detectada
      const jurisdictionInfo = forcedJurisdiction ? { jurisdiction: forcedJurisdiction } : this.jurisdictionService.detectJurisdiction(phone);
      const isBrazil = jurisdictionInfo.jurisdiction === 'BR';

      // 0.2 BR: Se a mensagem indicar upgrade/assinatura, responder com link estático e NÃO iniciar fluxo
      if (isBrazil) {
        const lower = text.toLowerCase();
        const upgradeKeywordsBR = [
          'upgrade', 'assinar', 'assinatura', 'plano', 'pago', 'premium', 'pro', 'mensal', 'anual',
          'trocar plano', 'mudar plano', 'quero plano', 'quero assinar', 'quero o pro', 'quero o premium',
          'comprar', 'preço', 'pagamento'
        ];
        if (upgradeKeywordsBR.some(k => lower.includes(k))) {
          const response = '🚀 Para fazer upgrade do seu plano, acesse: https://plataforma.lawx.ai/\n\n' +
            'Lá você encontrará os planos disponíveis e poderá concluir o upgrade com segurança.';
          await this.sendMessage(phone, response);
          return;
        }
      }

      // 1. Verificar se há sessão de upgrade ativa ou estado de upgrade (apenas PT/ES)
      // if (user && !isBrazil) {
      //   const activeSession = await this.upgradeSessionsService.getActiveSession(user.id, jurisdictionInfo.jurisdiction);
      //   if (activeSession || state.isInUpgradeFlow) {
      //     this.logger.log('🔄 Sessão de upgrade ativa, processando com Engine...');
      //     await this.upgradeFlowEngine.route(
      //       phone,
      //       user.id,
      //       text,
      //       activeSession,
      //       state,
      //       {
      //         handlePaymentConfirmation: (p, u, ctx) => this.handlePaymentConfirmation(p, u, ctx),
      //         handleFrequencySelectionWithAI: (p, u, m, ctx) => this.handleFrequencySelectionWithAI(p, u, m, ctx),
      //         handlePlanSelectionWithAI: (p, u, m, ctx) => this.handlePlanSelectionWithAI(p, u, m, ctx),
      //         handleCancelUpgrade: (p, u, s) => this.handleCancelUpgrade(p, u, s),
      //         handleContinueUpgrade: (p, u, m, ctx) => this.handleContinueUpgrade(p, u, m, ctx),
      //       }
      //     );
      //     return;
      //   }

      //   // 2. Verificar se é uma nova intenção de upgrade (apenas PT/ES)
      //   const upgradeIntent = await this.detectUpgradeIntent(text, user.id, jurisdictionInfo.jurisdiction);
      //   if (upgradeIntent.isUpgradeIntent && !isBrazil) {
      //     this.logger.log('🆕 Nova intenção de upgrade detectada:', upgradeIntent);
      //     await this.handleUpgradeFlow(phone, user.id, text, jurisdictionInfo.jurisdiction);
      //     return;
      //   }
      // }

      // 3. Log inbound texto
      try {
        const jurisdiction = forcedJurisdiction || this.jurisdictionService.detectJurisdiction(phone).jurisdiction;
        const convId = this.getConversationState(phone).conversationId;
        if (jurisdiction === 'BR') {
          await this.messagingLogBr.logInboundText({ phone, jurisdiction, text, conversationId: convId || undefined });
        } else {
          const check = await this.sessionService.checkWhatsAppSession(phone, jurisdiction);
          const sessionId = check.session?.id;
          if (sessionId) {
            await this.messagingLog.logInboundText({ sessionId, phone, jurisdiction, text, conversationId: convId });
          }
        }
      } catch {}

      // 4. Processar consulta jurídica
      await this.handleLegalConsultation(text, phone, user, forcedJurisdiction);

    } catch (error) {
      this.logger.error('❌ Erro ao processar mensagem de texto:', error);
      await this.sendMessage(phone, '❌ Erro ao processar sua mensagem. Tente novamente.');
    }
  }
  
  private async handleAudioMessage(message: any, user: User, phone: string, forcedJurisdiction?: string): Promise<void> {
    try {
      this.logger.log('🎵 Processando mensagem de áudio...');

      this.logger.log('🎵 Mensagem de áudio tipo:', JSON.stringify(message.message?.base64, null, 2));
      // Enviar mensagem de processamento conforme jurisdição
      const preJurisdiction = forcedJurisdiction 
        ? { jurisdiction: forcedJurisdiction } 
        : this.jurisdictionService.detectJurisdiction(phone);
      let preAudioMsg = '🎵 Processando seu áudio... Aguarde um momento.'; // BR (padrão)
      if (preJurisdiction.jurisdiction === 'PT') {
        preAudioMsg = '🎵 A processar o seu áudio... Por favor, aguarde um momento.';
      } else if (preJurisdiction.jurisdiction === 'ES') {
        preAudioMsg = '🎵 Procesando tu audio... Por favor, espera un momento.';
      }
      await this.sendMessageWithTyping(phone, preAudioMsg, 2000);
      
      let audioBuffer: Buffer | null = null;

      if(message.message?.base64) {
        audioBuffer = await this.processAudioBase64(message);
      if (!audioBuffer) {
        await this.sendMessage(phone, '❌ Não consegui processar o áudio. Tente novamente.');
        return;
        }
      } else if(message.audioMessage) {
        audioBuffer = await this.processAudioViaEvolutionAPI(message);
        if (!audioBuffer) {
          await this.sendMessage(phone, '❌ Não consegui processar o áudio. Tente novamente.');
          return;
        }
      }

      // Normalizar/converter áudio e upload
      const normalizedBuffer = await this.audioProcessor.convertToMp3WithFallback(audioBuffer);
      const audioUrl = await this.audioProcessor.uploadAudio(normalizedBuffer, 'audio.mp3');

      // Log inbound media
      const jurisdictionCode = forcedJurisdiction || this.jurisdictionService.detectJurisdiction(phone).jurisdiction;
      let sessionId: string | undefined;
      if (jurisdictionCode === 'BR') {
        await this.messagingLogBr.logInboundMedia({ phone, jurisdiction: jurisdictionCode, messageType: 'audio', url: audioUrl, conversationId: this.getConversationState(phone).conversationId });
      } else {
        const session = await this.sessionService.checkWhatsAppSession(phone, jurisdictionCode);
        sessionId = session.session?.id;
        if (sessionId) {
          await this.messagingLog.logInboundMedia({ sessionId, phone, jurisdiction: jurisdictionCode, messageType: 'audio', url: audioUrl, conversationId: this.getConversationState(phone).conversationId });
        }
      }
      
      // Processar áudio para consulta jurídica
      const transcribedText = await this.audioProcessor.transcribe(normalizedBuffer);
      if (jurisdictionCode === 'BR') {
        if (transcribedText) {
          await this.messagingLogBr.logInboundText({ phone, jurisdiction: jurisdictionCode, text: transcribedText, conversationId: this.getConversationState(phone).conversationId });
        }
      } else if (sessionId && transcribedText) {
        await this.messagingLog.logInboundText({ sessionId, phone, jurisdiction: jurisdictionCode, text: transcribedText, conversationId: this.getConversationState(phone).conversationId });
      }
      
      // Usar jurisdição forçada se fornecida, senão detectar
      const jurisdiction = forcedJurisdiction 
        ? { jurisdiction: forcedJurisdiction }
        : this.jurisdictionService.detectJurisdiction(phone);
      
      // Gerar resposta jurídica
      const response = await this.aiService.generateLegalResponse(
        transcribedText,
        phone,
        user?.id,
        undefined, // Sem conteúdo de documento
        forcedJurisdiction // Passar jurisdição forçada
      );
      
      await this.sendMessage(phone, response);
      if (jurisdiction.jurisdiction === 'BR') {
        await this.messagingLogBr.logOutboundText({ phone, jurisdiction: jurisdiction.jurisdiction, text: response, role: 'assistant', conversationId: this.getConversationState(phone).conversationId });
        if (user?.id) {
          await this.usageService.incrementUsage(user.id, 'message', phone);
        }
      } else if (sessionId && response) {
        await this.messagingLog.logOutboundText({ sessionId, phone, jurisdiction: jurisdiction.jurisdiction, text: response, role: 'assistant', conversationId: this.getConversationState(phone).conversationId });
      }
      
    } catch (error) {
      this.logger.error('❌ Erro ao processar áudio:', error);
      
      // Verificar se é erro de limite atingido (PRIORIDADE MÁXIMA)
      if (error.message && error.message.includes('Limite de mensagens atingido')) {
        await this.handleLimitReachedMessage(phone, user, error.message, forcedJurisdiction);
        return;
      }
      
      // Verificar se é erro de validação específico
      if (error.message.includes('Áudio não contém lançamento financeiro:')) {
        await this.sendMessage(phone, `❌ ${error.message}\n\n🎵 **Envie um áudio válido:**\n• "Aluguel 2000"\n• "Supermercado 150"\n• "Salário 5000"\n• "Freelance 800"\n\nFale claramente o valor e a descrição do lançamento.`);
        return;
      }
      
      // Verificar se é erro de formato de áudio
      if (error.message.includes('Invalid file format') || error.message.includes('formato')) {
        await this.sendMessage(phone, `❌ **Problema com o formato do áudio**\n\n🎵 **Solução:**\n• Envie um áudio mais curto (máximo 30 segundos)\n• Fale mais claramente\n• Evite ruídos de fundo\n• Tente novamente em alguns segundos\n\n**Exemplo:** "Aluguel 2000"`);
        return;
      }
      
      // Verificar se é erro de transcrição
      if (error.message.includes('transcrição') || error.message.includes('transcription')) {
        await this.sendMessage(phone, `❌ **Erro na transcrição do áudio**\n\n🎵 **Dicas:**\n• Fale mais devagar e claramente\n• Evite ruídos de fundo\n• Use frases simples como "Aluguel 2000"\n• Tente novamente`);
        return;
      }
      
      await this.sendMessage(phone, '❌ Erro ao processar o áudio. Tente novamente ou fale mais claramente.');
    }
  }

  private async handleDocumentMessage(message: any, user: User | null, phone: string, forcedJurisdiction?: string): Promise<void> {
    try {
      this.logger.log('📄 Processando mensagem de documento jurídico...');
      
      // ✅ NOVO: Verificar limite de análise de documentos ANTES de processar
      if (user?.id) {
        const usageCheck = await this.usageService.checkLimits(user.id, 'document_analysis', phone);
        if (!usageCheck.allowed) {
          this.logger.warn(`🚫 Limite de análise de documentos atingido para usuário ${user.id}`);
          await this.handleLimitReachedMessage(phone, user, usageCheck.message, forcedJurisdiction);
          return;
        }
      }
      
      // Definir estado de análise
      const conversationState = this.getConversationState(phone);
      this.setConversationState(phone, {
        ...conversationState,
        isInAnalysis: true,
        analysisStartTime: Date.now(),
        jurisdiction: forcedJurisdiction // ✅ NOVO: Armazenar jurisdição forçada no estado
      });
      
      // Extrair base64 da mensagem
      const base64Data = this.extractBase64FromDocumentMessage(message);
      if (!base64Data) {
        const errorMsg = this.getLocalizedErrorMessage('extract_document_failed', forcedJurisdiction);
        await this.sendMessage(phone, errorMsg);
        return;
      }

      // Converter base64 para buffer e delegar
      const documentBuffer = this.documentProcessor.convertBase64ToBuffer(base64Data);
      await this.processDocumentBinary(documentBuffer, { phone, user, jurisdiction: forcedJurisdiction });

    } catch (error) {
      this.logger.error('❌ Erro ao processar documento:', error);
      
      // Verificar se é erro de limite atingido (PRIORIDADE MÁXIMA)
      if (error.message && error.message.includes('Limite de mensagens atingido')) {
        await this.handleLimitReachedMessage(phone, user, error.message, forcedJurisdiction);
        return;
      }
      
      // Manter estado de análise e solicitar reenvio
      const retryMsg = this.getLocalizedErrorMessage('document_analysis_failed', forcedJurisdiction);
      await this.sendMessage(phone, retryMsg);
    }
  }

  private async saveLegalDocument(
    analysis: any,
    jurisdiction: string,
    userId?: string
  ): Promise<void> {
    try {
      if (jurisdiction === 'BR') {
        // Para Brasil - salvar no Supabase (via teams service)
        // TODO: Implementar salvamento de documento jurídico no Supabase
        // await this.teamsService.saveLegalDocument({
        //   userId: userId || '',
        //   type: analysis.type,
        //   content: analysis.analysis,
        //   analysis: analysis.analysis,
        //   jurisdiction,
        // });
      } else {
        // Para Portugal/Espanha - salvar no MySQL local
        // TODO: Implementar salvamento de documento jurídico no MySQL
        // await this.prismaService.createLegalDocument({
        //   userId: userId || '',
        //   type: analysis.type,
        //   content: analysis.analysis,
        //   analysis: analysis.analysis,
        //   jurisdiction,
        // });
      }
    } catch (error) {
      this.logger.error('Erro ao salvar documento jurídico:', error);
      // Não lançar erro para não interromper o fluxo
    }
  }

  // ===== Núcleos de processamento por BINÁRIO (reutilizados por Evolution e Cloud) =====
  private async processImageBinary(imageBuffer: Buffer, ctx: { phone: string; user: User | null; jurisdiction?: string }): Promise<void> {
    const { phone, user } = ctx;
    // Log inbound media
    const jurisdictionCode = this.jurisdictionService.detectJurisdiction(phone).jurisdiction;
    let sessionId: string | undefined;
    if (jurisdictionCode === 'BR') {
      await this.messagingLogBr.logInboundMedia({ phone, jurisdiction: jurisdictionCode, messageType: 'image', url: 'uploaded://image', conversationId: this.getConversationState(phone).conversationId });
    } else {
      const session = await this.sessionService.checkWhatsAppSession(phone, jurisdictionCode);
      sessionId = session.session?.id;
      if (sessionId) {
        await this.messagingLog.logInboundMedia({ sessionId, phone, jurisdiction: jurisdictionCode, messageType: 'image', url: 'uploaded://image', conversationId: this.getConversationState(phone).conversationId });
      }
    }

    // Mensagem inicial conforme jurisdição
    const imgJurisdiction = this.jurisdictionService.detectJurisdiction(phone);
    let preImageMsg = '🔍 Estou analisando o documento jurídico...';
    if (imgJurisdiction.jurisdiction === 'PT') preImageMsg = '🔍 A analisar o documento jurídico...';
    else if (imgJurisdiction.jurisdiction === 'ES') preImageMsg = '🔍 Estoy analizando el documento jurídico...';
    await this.sendMessageWithTyping(phone, preImageMsg, 2000);

    // Detectar jurisdição
    const jurisdiction = this.jurisdictionService.detectJurisdiction(phone);

    // Analisar documento jurídico (imagem)
    const analysis = await this.aiService.analyzeLegalDocument(
      imageBuffer,
      jurisdiction.jurisdiction,
      user?.id
    );

    if (jurisdiction.jurisdiction === 'BR' && analysis) {
      await this.messagingLogBr.logOutboundText({ phone, jurisdiction: jurisdiction.jurisdiction, text: '[analysis]', role: 'assistant', json: analysis, conversationId: this.getConversationState(phone).conversationId });
    } else if (sessionId && analysis) {
      await this.messagingLog.logOutboundText({ sessionId, phone, jurisdiction: jurisdiction.jurisdiction, text: '[analysis]', role: 'assistant', json: analysis, conversationId: this.getConversationState(phone).conversationId });
    }

    await this.saveLegalDocument(analysis, jurisdiction.jurisdiction, user?.id);

    const response = `📋 **Análise do Documento Jurídico**\n\n` +
      `**Tipo:** ${analysis.type}\n\n` +
      `**Análise:**\n${analysis.analysis}\n\n` +
      `**Riscos Identificados:**\n${analysis.risks.map((r: string) => `• ${r}`).join('\n')}\n\n` +
      `**Sugestões:**\n${analysis.suggestions.map((s: string) => `• ${s}`).join('\n')}\n\n` +
      `⚠️ *Esta análise é informativa. Para casos específicos, consulte um advogado.*`;

    await this.sendMessage(phone, response);
    if (jurisdiction.jurisdiction === 'BR') {
      await this.messagingLogBr.logOutboundText({ phone, jurisdiction: jurisdiction.jurisdiction, text: response, role: 'assistant', conversationId: this.getConversationState(phone).conversationId });
      if (user?.id) {
        await this.usageService.incrementUsage(user.id, 'message', phone);
      }
    } else if (sessionId) {
      await this.messagingLog.logOutboundText({ sessionId, phone, jurisdiction: jurisdiction.jurisdiction, text: response, role: 'assistant', conversationId: this.getConversationState(phone).conversationId });
    }

    if (user?.id) {
      await this.usageService.incrementUsage(user.id, 'document_analysis', phone);
    }
  }

  private async processDocumentBinary(documentBuffer: Buffer, ctx: { phone: string; user: User | null; jurisdiction?: string }): Promise<void> {
    const { phone, user, jurisdiction } = ctx;

    if (user?.id) {
      const usageCheck = await this.usageService.checkLimits(user.id, 'document_analysis', phone);
      if (!usageCheck.allowed) {
        await this.handleLimitReachedMessage(phone, user, usageCheck.message, jurisdiction);
        return;
      }
    }

    const conversationState = this.getConversationState(phone);
    this.setConversationState(phone, { ...conversationState, isInAnalysis: true, analysisStartTime: Date.now(), jurisdiction });

    const fileSizeMB = documentBuffer.length / (1024 * 1024);
    if (fileSizeMB > 20) {
      const errorMsg = this.getLocalizedErrorMessage('file_too_large', jurisdiction);
      await this.sendMessage(phone, errorMsg);
      return;
    }

    const mimeType = this.documentProcessor.detectDocumentMime(documentBuffer);
    if (!this.documentProcessor.isSupportedDocumentType(mimeType)) {
      const errorMsg = this.getLocalizedErrorMessage('unsupported_file_type', jurisdiction);
      await this.sendMessage(phone, errorMsg);
      return;
    }

    const analyzingMsg = this.getLocalizedMessage('analyzing_document', jurisdiction);
    await this.sendMessageWithTyping(phone, analyzingMsg, 2000);

    const fileName = this.documentProcessor.generateFileName(mimeType);
    const fileUrl = await this.documentProcessor.upload(documentBuffer, fileName);

    try {
      const jCode = jurisdiction || this.jurisdictionService.detectJurisdiction(phone).jurisdiction;
      if (jCode === 'BR') {
        await this.messagingLogBr.logInboundMedia({ phone, jurisdiction: jCode, messageType: 'document', url: fileUrl, conversationId: this.getConversationState(phone).conversationId });
      } else {
        const sessionCheck = await this.sessionService.checkWhatsAppSession(phone, jCode);
        const sId = sessionCheck.session?.id;
        if (sId) {
          await this.messagingLog.logInboundMedia({ sessionId: sId, phone, jurisdiction: jCode, messageType: 'document', url: fileUrl, conversationId: this.getConversationState(phone).conversationId });
        }
      }
    } catch {}

    const analysis = await this.documentProcessor.analyzeDocumentWithExternalAPI(fileUrl, jurisdiction);
    const formattedAnalysis = this.documentProcessor.formatDocumentAnalysisForUser(analysis, jurisdiction);
    await this.sendMessageWithTyping(phone, formattedAnalysis, 1500);

    try {
      const jCode = jurisdiction || this.jurisdictionService.detectJurisdiction(phone).jurisdiction;
      if (jCode === 'BR') {
        await this.messagingLogBr.logOutboundText({ phone, jurisdiction: jCode, text: formattedAnalysis, role: 'assistant', conversationId: this.getConversationState(phone).conversationId });
      } else {
        const sessionCheck = await this.sessionService.checkWhatsAppSession(phone, jCode);
        const sId = sessionCheck.session?.id;
        if (sId) {
          await this.messagingLog.logOutboundText({ sessionId: sId, phone, jurisdiction: jCode, text: formattedAnalysis, role: 'assistant', conversationId: this.getConversationState(phone).conversationId });
        }
      }
    } catch {}

    if (user?.id) {
      await this.usageService.incrementUsage(user.id, 'document_analysis', phone);
    }

    const anotherDocMsg = this.getLocalizedMessage('analyze_another_document', jurisdiction);
    await this.sendMessageWithTyping(phone, anotherDocMsg, 1000);
    if (user?.id && (jurisdiction === 'BR')) {
      await this.usageService.incrementUsage(user.id, 'message', phone);
    }
  }

  private async processAudioBinary(mp3Buffer: Buffer, ctx: { phone: string; user: User | null; jurisdiction?: string }): Promise<void> {
    const { phone, user, jurisdiction } = ctx;
    const audioUrl = await this.audioProcessor.uploadAudio(mp3Buffer, 'audio.mp3');
    const jurisdictionCode = jurisdiction || this.jurisdictionService.detectJurisdiction(phone).jurisdiction;
    let sessionId: string | undefined;
    if (jurisdictionCode !== 'BR') {
      const session = await this.sessionService.checkWhatsAppSession(phone, jurisdictionCode);
      sessionId = session.session?.id;
      if (sessionId) {
        await this.messagingLog.logInboundMedia({ sessionId, phone, jurisdiction: jurisdictionCode, messageType: 'audio', url: audioUrl, conversationId: this.getConversationState(phone).conversationId });
      }
    }
    const transcribedText = await this.audioProcessor.transcribe(mp3Buffer);
    if (jurisdictionCode !== 'BR' && sessionId && transcribedText) {
      await this.messagingLog.logInboundText({ sessionId, phone, jurisdiction: jurisdictionCode, text: transcribedText, conversationId: this.getConversationState(phone).conversationId });
    }
    const j = jurisdiction || this.jurisdictionService.detectJurisdiction(phone).jurisdiction;
    const response = await this.aiService.generateLegalResponse(transcribedText, phone, user?.id, undefined, jurisdiction);
    await this.sendMessage(phone, response);
    if (j === 'BR') {
      await this.messagingLogBr.logOutboundText({ phone, jurisdiction: j, text: response, role: 'assistant', conversationId: this.getConversationState(phone).conversationId });
      if (user?.id) {
        await this.usageService.incrementUsage(user.id, 'message', phone);
      }
    } else if (sessionId && response) {
      await this.messagingLog.logOutboundText({ sessionId, phone, jurisdiction: j, text: response, role: 'assistant', conversationId: this.getConversationState(phone).conversationId });
    }
  }

  private async handleLegalConsultation(text: string, phone: string, user: User | null, forcedJurisdiction?: string): Promise<void> {
    try {
      // Usar jurisdição forçada se fornecida, senão detectar
      const jurisdiction = forcedJurisdiction 
        ? { jurisdiction: forcedJurisdiction }
        : this.jurisdictionService.detectJurisdiction(phone);
      
      // Construir contexto curto (4+4) a partir do histórico persistido
      let finalText = text;
      try {
        if (jurisdiction.jurisdiction !== 'BR') {
          const check = await this.sessionService.checkWhatsAppSession(phone, jurisdiction.jurisdiction);
          const sessionId = check.session?.id;
          if (sessionId) {
            const ctx = await this.contextBuilder.buildConversationContext({
              sessionId,
              phone,
              jurisdiction: jurisdiction.jurisdiction,
              userLimit: 4,
              assistantLimit: 4,
            });
            if (ctx && ctx.length > 0) {
              const history = ctx
                .map(m => `${m.role === 'user' ? 'Usuário' : 'Assistente'}: ${m.content}`)
                .join('\n');
              finalText = `HISTÓRICO (últimas trocas):\n${history}\n\nNOVA MENSAGEM DO USUÁRIO:\n${text}`;
            }
          }
        }
      } catch {}

      // Gerar resposta jurídica
      const response = await this.aiService.generateLegalResponse(
        finalText,
        phone,
        user?.id,
        undefined, // Sem conteúdo de documento
        forcedJurisdiction // Passar jurisdição forçada
      );
      
      await this.sendMessageWithTyping(phone, response, 2000);
      try {
        const convId = this.getConversationState(phone).conversationId;
        if (jurisdiction.jurisdiction === 'BR') {
          await this.messagingLogBr.logOutboundText({ phone, jurisdiction: jurisdiction.jurisdiction, text: response, role: 'assistant', conversationId: convId });
          if (user?.id) {
            await this.usageService.incrementUsage(user.id, 'message', phone);
          }
        } else {
          const check = await this.sessionService.checkWhatsAppSession(phone, jurisdiction.jurisdiction);
          const sessionId = check.session?.id;
          if (sessionId && response) {
            await this.messagingLog.logOutboundText({ sessionId, phone, jurisdiction: jurisdiction.jurisdiction, text: response, role: 'assistant', conversationId: convId });
          }
        }
      } catch {}
      
    } catch (error) {
      this.logger.error('Erro ao processar consulta jurídica:', error);
      
      // Verificar se é erro de limite atingido
      if (error.message && error.message.includes('Limite de mensagens atingido')) {
        await this.handleLimitReachedMessage(phone, user, error.message, forcedJurisdiction);
      } else {
        await this.sendMessage(phone, '❌ Erro ao processar sua consulta jurídica. Tente novamente.');
      }
    }
  }

  private async handleLimitReachedMessage(phone: string, user: User | null, errorMessage: string, forcedJurisdiction?: string): Promise<void> {
    try {
      // Usar jurisdição forçada se fornecida, senão detectar
      const jurisdiction = forcedJurisdiction 
        ? { jurisdiction: forcedJurisdiction }
        : this.jurisdictionService.detectJurisdiction(phone);
      
      if (jurisdiction.jurisdiction === 'BR') {
        // Mensagem específica para usuários brasileiros
        const response = `🚫 **Limite de mensagens atingido!**\n\n` +
          `Você utilizou todas as suas mensagens disponíveis.\n\n` +
          `💡 **Como fazer upgrade:**\n` +
          `• Acesse o portal e escolha um plano: https://plataforma.lawx.ai/\n` +
          `• O upgrade é feito diretamente no site\n\n` +
          `📞 **Suporte:** Entre em contato conosco para mais informações.`;
        
        await this.sendMessage(phone, response);
      } else {
        // Para PT/ES - usar mensagem localizada com IA
        try {
          // Extrair informações do erro para personalizar a mensagem
          const usageMatch = errorMessage.match(/(\d+) de (\d+)/);
          const currentUsage = usageMatch ? parseInt(usageMatch[1]) : 0;
          const limit = usageMatch ? parseInt(usageMatch[2]) : 0;
          
          const localizedMessage = await this.generateLimitExceededMessage(
            jurisdiction.jurisdiction, 
            currentUsage, 
            limit
          );
          
          await this.sendMessage(phone, localizedMessage);

          // Em seguida, enviar lista de planos disponíveis (exclui Fremium) para PT/ES
          // await this.sendPlanOptionsAfterLimit(phone, jurisdiction.jurisdiction);

          // NOVO: Enviar landing page de upgrade por jurisdição (standby)
          const landingUrl = jurisdiction.jurisdiction === 'ES' ? 'https://es.lawx.ai/plans' : 'https://pt.lawx.ai/plans';
          const landingMsg = jurisdiction.jurisdiction === 'ES'
            ? `🚀 **Actualiza tu plan**\n\n` +
              `Para continuar, accede a nuestra página y elige el plan que prefieras:\n${landingUrl}\n\n` +
              `Allí verás todos los planes disponibles y podrás completar la suscripción con seguridad.`
            : `🚀 **Atualize o seu plano**\n\n` +
              `Para continuar, aceda à nossa página e escolha o plano que preferir:\n${landingUrl}\n\n` +
              `Lá verá todos os planos disponíveis e poderá concluir a subscrição com segurança.`;
          await this.sendMessage(phone, landingMsg);

          return;

          // Criar sessão inicial de upgrade (STANDBY)
          // Observação importante:
          // - Mantemos toda a infraestrutura do fluxo de upgrade (sessão, roteamento, engine)
          // - NÃO removemos nem desativamos o fluxo; apenas deixamos a sessão criada
          // - O avanço do fluxo no WhatsApp fica em standby, pois o usuário seguirá pela landing
          // - Caso volte a interagir no WhatsApp, a sessão já existe e poderá ser retomada
          if (user) {
            try {
              await this.upgradeSessionsService.createSession({
                user_id: user.id,
                phone,
                plan_name: '',
                billing_cycle: 'monthly',
                amount: 0,
                current_step: 'plan_selection',
                jurisdiction: jurisdiction.jurisdiction,
              });
            } catch {}
          }
          // STANDBY: não alterar o estado da conversa para evitar continuar o fluxo no WhatsApp
          // Deixe o estado do usuário como está; o fluxo pode ser retomado no futuro
          // const state = this.getConversationState(phone);
          // state.isInUpgradeFlow = true;
          // state.upgradeStep = 'plan_selection';
          // this.setConversationState(phone, state);
        } catch (aiError) {
          this.logger.error('Erro ao gerar mensagem localizada:', aiError);
          
          // Fallback para mensagem estática
          const response = `🚫 **Limite de mensagens atingido!**\n\n` +
            `Você utilizou todas as suas mensagens disponíveis.\n\n` +
            `💡 **Que tal fazer um upgrade?**\n` +
            `• Acesse planos premium com mensagens ilimitadas\n` +
            `• Recursos avançados de análise jurídica\n` +
            `• Suporte prioritário\n\n` +
            `🔄 Digite "UPGRADE" para ver os planos disponíveis ou "MENU" para outras opções.`;
          
          await this.sendMessage(phone, response);
        }
      }
      
    } catch (error) {
      this.logger.error('Erro ao processar mensagem de limite:', error);
      await this.sendMessage(phone, '❌ Limite atingido. Entre em contato para mais informações.');
    }
  }

  private async sendPlanOptionsAfterLimit(phone: string, jurisdiction: string): Promise<void> {
    try {
      const plans = await this.getUpgradePlans(jurisdiction);
      if (!plans || plans.length === 0) {
        return;
      }

      const isES = jurisdiction === 'ES';
      const currency = (jurisdiction === 'ES' || jurisdiction === 'PT') ? '€' : 'R$';
      const title = isES ? '📋 Planes disponibles (Mensual/Anual):' : '📋 Planos disponíveis (Mensal/Anual):';
      const monthlyLabel = isES ? 'Mensual' : 'Mensal';
      const annualLabel = isES ? 'Anual' : 'Anual';
      const discountWord = isES ? 'descuento' : 'desconto';
      const unlimitedText = isES ? 'Límites: ilimitados' : 'Limites: ilimitados';

      const limitsLine = (plan: any) => {
        if (plan.is_unlimited) return unlimitedText;
        if (isES) {
          return `Límites: consultas ${plan.consultation_limit ?? 0}/mes • análisis ${plan.document_analysis_limit ?? 0}/mes • mensajes ${plan.message_limit ?? 0}/mes`;
        }
        return `Limites: consultas ${plan.consultation_limit ?? 0}/mês • análises ${plan.document_analysis_limit ?? 0}/mês • mensagens ${plan.message_limit ?? 0}/mês`;
      };

      const lines: string[] = [];
      lines.push(title);
      for (const plan of plans) {
        const hasDiscount = plan.yearly_price < (plan.monthly_price * 12);
        const discountText = hasDiscount
          ? ` (${Math.round(((plan.monthly_price * 12 - plan.yearly_price) / (plan.monthly_price * 12)) * 100)}% de ${discountWord})`
          : '';

        lines.push(
          `
⭐ ${plan.name.toUpperCase()}
• ${monthlyLabel}: ${currency} ${plan.monthly_price.toFixed(2)}/${isES ? 'mes' : 'mês'}
• ${annualLabel}: ${currency} ${plan.yearly_price.toFixed(2)}/${isES ? 'año' : 'ano'}${discountText}
• ${limitsLine(plan)}`.trim()
        );
      }

      lines.push(isES
        ? '\n💬 Responde con el nombre del plan (p. ej.: "Pro" o "Premium").'
        : '\n💬 Responda com o nome do plano (ex.: "Pro" ou "Premium").'
      );
      await this.sendMessageWithTyping(phone, lines.join('\n'), 1500);
    } catch (error) {
      this.logger.error('Erro ao enviar lista de planos após limite:', error);
    }
  }

  private async showLegalMenu(phone: string, jurisdiction: string): Promise<void> {
    try {
      // ✅ NOVO: Gerar menu localizado com IA
      const menuPrompt = `Gere uma mensagem de menu jurídico para o Chat LawX, um assistente jurídico especializado.

Jurisdição: ${getJurisdiction(jurisdiction)}
Idioma: ${getJurisdictionLanguage(jurisdiction)}

Use obrigatoriamente no idioma ${getJurisdictionLanguage(jurisdiction)} para responder.

Requisitos:
- Deve mencionar obrigatoriamente "Chat LawX"
- Deve especificar que é um assistente jurídico
- Tom profissional e útil
- Máximo 8 linhas
- Use emojis apropriados apenas na primeira linha
- Funcionalidades: Enviar documentos jurídicos, Fazer consultas jurídicas por texto ou audio.
- Incluir instruções de uso: Digite pergunta jurídica, Envie foto/documento para análise
- Aviso: Este é um Assistente informativo, caso precise de uma consulta jurídica específica, consulte um advogado.

A estrutura abaixo deve estar no idioma ${getJurisdictionLanguage(jurisdiction)}, nao precisa ser especificamente em portugues, pode ser em outro idioma.

Estrutura:
[Emoji] *[Chat LawX - Menu Jurídico]*
*Funcionalidades Disponíveis:*
[Lista de funcionalidades]
*Como usar:*
• [Instruções]
*Aviso sobre consulta a advogado*`;

      const localizedMenu = await this.aiGateway.executeCustomPrompt(
        menuPrompt,
        'gpt-4o-mini',
        'Você é um especialista em criar menus jurídicos localizados para assistentes jurídicos. Seja profissional e útil.',
        0.7
      );
      
      await this.sendMessageWithTyping(phone, localizedMenu, 1500);
    } catch (error) {
      this.logger.error(`❌ Erro ao gerar menu localizado:`, error);
      
      // Fallback para menu padrão em português brasileiro
      const fallbackMenu = `⚖️ **Chat LawX - Menu Jurídico**\n\n` +
        `📋 **Funcionalidades Disponíveis:**\n` +
        `• Envie documentos jurídicos (contratos, petições, etc.)\n` +
        `• Faça consultas jurídicas por texto\n` +
        `• Análise de riscos em documentos\n` +
        `• Sugestões de cláusulas contratuais\n` +
        `💡 **Como usar:**\n` +
        `• Digite sua pergunta jurídica\n` +
        `• Envie foto de documento para análise\n` +
        `⚠️ *Lembre-se: Este é um assistente informativo. Para casos específicos, consulte um advogado.*`;
      
      await this.sendMessageWithTyping(phone, fallbackMenu, 1500);
    }
  }

  private async detectUpgradeIntent(text: string, userId: string, jurisdiction: string): Promise<{
    isUpgradeIntent: boolean;
    confidence: number;
    intent: 'new_upgrade' | 'continue_upgrade' | 'payment_confirmation' | 'frequency_selection' | 'plan_selection' | 'cancel_upgrade';
    context?: any;
  }> {
    try {
      this.logger.log('🔄 Detectando intent de upgrade com IA:', text);
      
      // Verificar se há sessão ativa primeiro
      const activeSession = await this.upgradeSessionsService.getActiveSession(userId, jurisdiction);
      const state = this.getConversationState(userId.replace('@s.whatsapp.net', ''));
      
      // Se há sessão ativa ou estado de upgrade, analisar no contexto
      if (activeSession || state.isInUpgradeFlow) {
        this.logger.log('🔄 Sessão ativa encontrada, analisando contexto...');
        return await this.analyzeUpgradeContext(text, activeSession, state, jurisdiction);
      }
      
      // Se não há sessão, verificar se é um novo intent de upgrade
      const newUpgradeIntent = await this.detectNewUpgradeIntent(text);
      if (newUpgradeIntent.isUpgradeIntent) {
        this.logger.log('🆕 Novo intent de upgrade detectado:', newUpgradeIntent);
        return newUpgradeIntent;
      }
      
      return {
        isUpgradeIntent: false,
        confidence: 0,
        intent: 'new_upgrade'
      };
      
    } catch (error) {
      this.logger.error('❌ Erro ao detectar intent de upgrade:', error);
      return {
        isUpgradeIntent: false,
        confidence: 0,
        intent: 'new_upgrade'
      };
    }
  }

  private async analyzeUpgradeContext(text: string, session: any, state: any, jurisdiction: string): Promise<{
    isUpgradeIntent: boolean;
    confidence: number;
    intent: 'new_upgrade' | 'continue_upgrade' | 'payment_confirmation' | 'frequency_selection' | 'plan_selection' | 'cancel_upgrade';
    context?: any;
  }> {
    try {
      this.logger.log('🧠 Analisando contexto de upgrade com IA...');
      
      const context = {
        currentStep: session?.current_step || state.upgradeStep,
        selectedPlan: session?.plan_name || state.selectedPlan,
        selectedFrequency: session?.billing_cycle || state.selectedFrequency,
        amount: session?.amount || 0,
        sessionId: session?.id
      };
      
      this.logger.log('📋 Contexto atual:', context);
      
      // Usar IA para analisar a intenção no contexto
      const aiAnalysis = await this.aiService.analyzePlanUpgradeIntent(text, context);
      
      this.logger.log('🤖 Análise da IA:', aiAnalysis);
      
      return {
        isUpgradeIntent: true,
        confidence: aiAnalysis.confidence,
        intent: aiAnalysis.intent,
        context: context
      };
      
    } catch (error) {
      this.logger.error('❌ Erro ao analisar contexto:', error);
      // Fallback para detecção manual
      return await this.fallbackUpgradeIntentDetection(text, session, state, jurisdiction);
    }
  }

  private async detectNewUpgradeIntent(text: string): Promise<{
    isUpgradeIntent: boolean;
    confidence: number;
    intent: 'new_upgrade' | 'continue_upgrade' | 'payment_confirmation' | 'frequency_selection' | 'plan_selection' | 'cancel_upgrade';
    context?: any;
  }> {
    try {
      this.logger.log('🆕 Detectando novo intent de upgrade...');
      
      const newUpgradeIntent = await this.aiService.detectNewPlanUpgradeIntent(text);
      
      this.logger.log('🤖 Novo intent detectado:', newUpgradeIntent);
      
      // Se IA não identificar claramente, usar fallback por palavras-chave (PT/ES)
      if (!newUpgradeIntent.isUpgradeIntent) {
        const lower = text.toLowerCase();
        const keywords = [
          // PT
          'upgrade', 'assinar', 'assinatura', 'plano', 'pago', 'premium', 'pro', 'mensal', 'anual',
          'trocar plano', 'mudar plano', 'quero plano', 'quero assinar', 'quero o pro', 'quero o premium',
          // ES
          'suscripcion', 'suscripción', 'suscribirme', 'suscribir', 'plan', 'mejorar', 'actualizar plan', 'cambiar plan',
          'quiero plan', 'quiero suscribirme', 'pagar', 'precio'
        ];
        const hasKeyword = keywords.some(k => lower.includes(k));
        if (hasKeyword) {
          return {
            isUpgradeIntent: true,
            confidence: Math.max(newUpgradeIntent.confidence || 0.5, 0.6),
            intent: 'new_upgrade',
            context: { isNewIntent: true, detectedBy: 'keywords' }
          };
        }
      }
      
      return {
        isUpgradeIntent: newUpgradeIntent.isUpgradeIntent,
        confidence: newUpgradeIntent.confidence,
        intent: 'new_upgrade',
        context: { isNewIntent: true }
      };
      
    } catch (error) {
      this.logger.error('❌ Erro ao detectar novo intent:', error);
      return {
        isUpgradeIntent: false,
        confidence: 0,
        intent: 'new_upgrade'
      };
    }
  }

  private async fallbackUpgradeIntentDetection(text: string, session: any, state: any, jurisdiction: string): Promise<{
    isUpgradeIntent: boolean;
    confidence: number;
    intent: 'new_upgrade' | 'continue_upgrade' | 'payment_confirmation' | 'frequency_selection' | 'plan_selection' | 'cancel_upgrade';
    context?: any;
  }> {
    try {
      // Usar IA para detectar confirmação/negação
      const detection = await this.aiService.detectConfirmationOrDenial(text, jurisdiction);
      
      // Detecção de cancelamento
      if (detection.isDenial && detection.confidence > 0.7) {
        return {
          isUpgradeIntent: true,
          confidence: detection.confidence,
          intent: 'cancel_upgrade',
          context: { session, state }
        };
      }
      
      // Detecção de confirmação de pagamento
      if (detection.isConfirmation && detection.confidence > 0.7) {
        return {
          isUpgradeIntent: true,
          confidence: detection.confidence,
          intent: 'payment_confirmation',
          context: { session, state }
        };
      }
    } catch (error) {
      this.logger.error('❌ Erro ao usar IA para detecção de upgrade, usando fallback:', error);
    }
    
    // Fallback para detecção simples
    const lowerText = text.toLowerCase();
    
    // Detecção de cancelamento
    if (lowerText.includes('cancelar') || lowerText.includes('cancel') || 
        lowerText.includes('não') || lowerText.includes('nao') || 
        lowerText.includes('desistir') || lowerText.includes('parar')) {
      return {
        isUpgradeIntent: true,
        confidence: 0.8,
        intent: 'cancel_upgrade',
        context: { session, state }
      };
    }
    
    // Detecção de confirmação de pagamento
    if (lowerText.includes('sim') || lowerText.includes('ok') || 
        lowerText.includes('pode ser') || lowerText.includes('vamos') ||
        lowerText.includes('pagar') || lowerText.includes('prosseguir')) {
      return {
        isUpgradeIntent: true,
        confidence: 0.7,
        intent: 'payment_confirmation',
        context: { session, state }
      };
    }
    
    // Detecção de seleção de frequência
    if (lowerText.includes('mensal') || lowerText.includes('anual') || 
        lowerText.includes('monthly') || lowerText.includes('yearly') ||
        lowerText.includes('mês') || lowerText.includes('ano')) {
      return {
        isUpgradeIntent: true,
        confidence: 0.8,
        intent: 'frequency_selection',
        context: { session, state }
      };
    }
    
    // Detecção de seleção de plano
    if (lowerText.includes('pro') || lowerText.includes('premium') || 
        lowerText.includes('básico') || lowerText.includes('basico')) {
      return {
        isUpgradeIntent: true,
        confidence: 0.8,
        intent: 'plan_selection',
        context: { session, state }
      };
    }
    
    return {
      isUpgradeIntent: false,
      confidence: 0,
      intent: 'new_upgrade'
    };
  }

  private async downloadImage(messageData: any): Promise<Buffer> {
    return this.mediaDownloader.downloadImageFromMessage(messageData);
  }

  private async downloadFromWhatsAppMedia(messageData: any): Promise<Buffer> {
    try {
      // Usar o key.id da mensagem em vez de extrair da URL
      const messageId = messageData.key?.id;
      
      if (!messageId) {
        throw new Error('ID da mensagem não encontrado');
      }
      
      console.log('📥 Message ID da mensagem:', messageId);
      
      // Construir URL da API de mídia correta usando getBase64FromMediaMessage
      const evolutionApiUrl = this.configService.get('EVOLUTION_API_URL');
      const instanceName = this.configService.get('EVOLUTION_INSTANCE_NAME');
      const apiKey = this.configService.get('EVOLUTION_API_KEY');
      
      // Usar o endpoint correto para obter mídia em base64
      const mediaUrl = `${evolutionApiUrl}/chat/getBase64FromMediaMessage/${instanceName}`;
      
      console.log('📥 URL da API de mídia (base64):', mediaUrl);
      
      // Payload correto conforme documentação
      const payload = {
        message: {
          key: {
            id: messageId
          }
        },
        convertToMp4: false
      };
      
      console.log('📥 Payload enviado:', JSON.stringify(payload, null, 2));
      
      const response = await axios.post(
        mediaUrl,
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            'apikey': apiKey,
          },
          timeout: 30000,
        }
      );

      console.log('📥 Resposta da API de mídia (base64), status:', response.status);
      
      if (response.data && response.data.base64) {
        console.log('📥 Base64 recebido, tamanho:', response.data.base64.length, 'caracteres');
        console.log('📥 Tipo de mídia:', response.data.mediaType);
        console.log('📥 Nome do arquivo:', response.data.fileName);
        console.log('📥 Tamanho:', response.data.size);
        
        // Converter base64 para buffer
        const buffer = Buffer.from(response.data.base64, 'base64');
        console.log('📥 Buffer convertido do base64, tamanho:', buffer.length, 'bytes');
        
        return buffer;
      } else {
        console.error('❌ Resposta inesperada:', response.data);
        throw new Error('Base64 não encontrado na resposta');
      }
    } catch (error) {
      console.error('❌ Erro na API de mídia (base64):', error);
      
      if (error.response) {
        console.error('❌ Status da resposta:', error.response.status);
        console.error('❌ Dados da resposta:', error.response.data);
      }
      
      throw error;
    }
  }

  private async downloadFromMessagesAPI(messageData: any): Promise<Buffer> {
    try {
      // Usar o key.id da mensagem em vez de extrair da URL
      const messageId = messageData.key?.id;
      
      if (!messageId) {
        throw new Error('ID da mensagem não encontrado (fallback)');
      }
      
      console.log('📥 Message ID extraído (fallback):', messageId);
      
      // Construir URL da API de mídia usando getBase64FromMediaMessage
      const evolutionApiUrl = this.configService.get('EVOLUTION_API_URL');
      const instanceName = this.configService.get('EVOLUTION_INSTANCE_NAME');
      const apiKey = this.configService.get('EVOLUTION_API_KEY');
      
      // Usar o mesmo endpoint base64 como fallback
      const mediaUrl = `${evolutionApiUrl}/chat/getBase64FromMediaMessage/${instanceName}`;
      
      console.log('📥 URL da API de mídia (fallback base64):', mediaUrl);
      
      // Payload correto conforme documentação
      const payload = {
        message: {
          key: {
            id: messageId
          }
        },
        convertToMp4: false
      };
      
      console.log('📥 Payload enviado (fallback):', JSON.stringify(payload, null, 2));
      
      const response = await axios.post(
        mediaUrl,
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            'apikey': apiKey,
          },
          timeout: 30000,
        }
      );

      console.log('📥 Resposta da API de mídia (fallback), status:', response.status);
      
      if (response.data && response.data.base64) {
        console.log('📥 Base64 recebido (fallback), tamanho:', response.data.base64.length, 'caracteres');
        console.log('📥 Tipo de mídia (fallback):', response.data.mediaType);
        console.log('📥 Nome do arquivo (fallback):', response.data.fileName);
        
        // Converter base64 para buffer
        const buffer = Buffer.from(response.data.base64, 'base64');
        console.log('📥 Buffer convertido do base64 (fallback), tamanho:', buffer.length, 'bytes');
        
        return buffer;
      } else {
        console.error('❌ Resposta inesperada (fallback):', response.data);
        throw new Error('Base64 não encontrado na resposta (fallback)');
      }
    } catch (error) {
      console.error('❌ Erro na API de mídia (fallback):', error);
      
      if (error.response) {
        console.error('❌ Status da resposta (fallback):', error.response.status);
        console.error('❌ Dados da resposta (fallback):', error.response.data);
      }
      
      throw error;
    }
  }

  private async downloadDirectFromUrl(url: string): Promise<Buffer> {
    try {
      console.log('📥 Baixando diretamente da URL:', url);
      
      const headers = {
        'User-Agent': 'WhatsApp/2.23.24.78 A',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Referer': 'https://web.whatsapp.com/',
      };

      const response = await axios.get(url, { 
        responseType: 'arraybuffer',
        headers,
        timeout: 30000,
        maxRedirects: 5,
        validateStatus: (status) => status < 400,
      });

      console.log('📥 Download direto, status:', response.status);
      console.log('📥 Content-Type:', response.headers['content-type']);

      const buffer = Buffer.from(response.data);
      console.log('📥 Buffer direto criado, tamanho:', buffer.length, 'bytes');

      return buffer;
    } catch (error) {
      console.error('❌ Erro no download direto:', error);
      throw error;
    }
  }

  /**
   * Envia mensagem de texto via WhatsApp com typing presence integrado
   * @param phone - Número do destinatário
   * @param message - Texto da mensagem
   * @param typingDelay - Tempo em milissegundos para typing presence (padrão: 1500ms, undefined para usar padrão, 0 para desabilitar)
   */
  private getRoutingJurisdiction(phone: string): string {
    const state = this.getConversationState(phone);
    if (state?.jurisdiction) return state.jurisdiction as string;
    return this.jurisdictionService.detectJurisdiction(phone).jurisdiction;
  }

  async sendMessage(phone: string, message: string, typingDelay?: number): Promise<void> {
    const flagEnabledIberia = String(this.configService.get('USE_CLOUD_API_PT_ES') || '').toLowerCase() === 'true';
    const flagEnabledBR = String(this.configService.get('USE_CLOUD_API_BR') || '').toLowerCase() === 'true';
    const state = this.getConversationState(phone);
    const j = this.getRoutingJurisdiction(phone);
    // Priorizar transporte Cloud se o inbound veio pela API Oficial
    if (state?.isCloudTransport === true || (flagEnabledIberia && (j === 'PT' || j === 'ES')) || (flagEnabledBR && j === 'BR')) {
      await this.cloudClient.sendText(phone, message);
      return;
    }
    await this.whatsappClient.sendText(phone, message, typingDelay);
  }

  /**
   * Envia mensagem com typing presence integrado
   * @param phone - Número do destinatário
   * @param message - Texto da mensagem
   * @param typingDelay - Tempo em milissegundos para typing presence (padrão: 1500ms, 0 para desabilitar)
   */
  async sendMessageWithTyping(phone: string, message: string, typingDelay: number = 1500): Promise<void> {
    await this.sendMessage(phone, message, typingDelay);
  }

  /**
   * Envia mensagem sem typing presence (para casos especiais)
   * @param phone - Número do destinatário
   * @param message - Texto da mensagem
   */
  async sendMessageInstant(phone: string, message: string): Promise<void> {
    await this.sendMessage(phone, message, 0);
  }

  /**
   * Simula ação "Digitando..." no WhatsApp
   * @param phone - Número do destinatário
   * @param delay - Tempo em milissegundos para manter o status (padrão: 1200ms)
   */
  async sendTypingPresence(phone: string, delay: number = 1200): Promise<void> {
    const flagEnabledIberia = String(this.configService.get('USE_CLOUD_API_PT_ES') || '').toLowerCase() === 'true';
    const flagEnabledBR = String(this.configService.get('USE_CLOUD_API_BR') || '').toLowerCase() === 'true';
    const state = this.getConversationState(phone);
    const j = this.getRoutingJurisdiction(phone);
    if (state?.isCloudTransport === true || (flagEnabledIberia && (j === 'PT' || j === 'ES')) || (flagEnabledBR && j === 'BR')) {
      // Cloud API não possui typing; fazemos no-op
      return;
    }
    await this.whatsappClient.sendTyping(phone, delay);
  }

  /**
   * Gera mensagem de limite excedido localizada usando IA
   */
  async generateLimitExceededMessage(jurisdiction: string, currentUsage: number, limit: number): Promise<string> {
    try {
      const prompt = `Gere uma mensagem de limite excedido para o Chat LawX, um assistente jurídico especializado.

Jurisdição: ${getJurisdiction(jurisdiction)}
Idioma: ${getJurisdictionLanguage(jurisdiction)}
Uso atual: ${currentUsage} mensagens
Limite: ${limit} mensagens
Planos Disponíveis: ${(await this.getUpgradePlans(jurisdiction)).map(plan => `${plan.name} - ${plan.monthly_price}€/mês\n\n: ${plan.features.join(', ')}`)}
Você deve responder em ${getJurisdictionLanguage(jurisdiction)} de forma obrigatória.

Mensagem a ser enviada:

Ops, seu limite de mensagens gratuita foi excedido! 😅

Mas você pode escolher um de nossos planos para continuar:
Listar Planos Disponíveis
`;

      const message = await this.aiGateway.executeCustomPrompt(
        prompt,
        'gpt-4o-mini',
        'Você é um especialista em criar mensagens de limite excedido para assistentes jurídicos. Seja claro e ofereça soluções.',
        0.7,
        400
      );

      this.logger.log(`✅ Mensagem de limite excedido gerada para ${jurisdiction}`);
      return message;
    } catch (error) {
      this.logger.error(`❌ Erro ao gerar mensagem de limite excedido:`, error);
      
      // Fallback para mensagem estática
      if (jurisdiction === 'ES') {
        return `🚫 **¡Límite de mensajes alcanzado!**

Has utilizado todas tus mensajes disponibles (${currentUsage}/${limit}).

💡 **Opciones disponibles:**
• Actualiza tu plan para obtener más mensajes
• Espera al próximo período de renovación

📞 **Soporte:** Contáctanos para más información.`;
      } else {
        return `🚫 **Limite de mensagens atingido!**

Utilizou todas as suas mensagens disponíveis (${currentUsage}/${limit}).

💡 **Opções disponíveis:**
• Atualize o seu plano para obter mais mensagens
• Aguarde o próximo período de renovação

📞 **Suporte:** Entre em contacto connosco para mais informações.`;
      }
    }
  }

  async sendImage(phone: string, base64Image: string, caption?: string): Promise<void> {
    await this.whatsappClient.sendImage(phone, base64Image, caption);
  }

  private getConversationState(phone: string): ConversationState {
    const state = this.stateStore.get(phone);
    return state || this.createDefaultState();
  }

  private setConversationState(phone: string, state: Partial<ConversationState>): void {
    const currentState = this.stateStore.get(phone) || this.createDefaultState();
    this.stateStore.set(phone, { ...currentState, ...state });
  }

  private clearConversationState(phone: string): void {
    this.stateStore.clear(phone);
  }

  /**
   * Retorna usuários que estão em análise de documento
   * Método público para ser usado pelo AnalysisTimeoutService
   */
  public getUsersInAnalysis(): Array<{
    phone: string;
    jurisdiction: string;
    analysisStartTime: number;
  }> {
    const result: Array<{ phone: string; jurisdiction: string; analysisStartTime: number }> = [];
    const entries = this.stateStore.entries();
    for (const { phone, state } of entries) {
      if (state.isInAnalysis && state.analysisStartTime) {
        const jurisdiction = state.jurisdiction || this.jurisdictionService.detectJurisdiction(phone).jurisdiction;
        result.push({ phone, jurisdiction, analysisStartTime: state.analysisStartTime });
      }
    }
    return result;
  }

  /**
   * Limpa o estado de análise para um usuário específico
   * Método público para ser usado pelo AnalysisTimeoutService
   */
  public clearAnalysisState(phone: string): void {
    const currentState = this.getConversationState(phone);
    if (currentState.isInAnalysis) {
      this.setConversationState(phone, {
        isInAnalysis: false,
        analysisStartTime: undefined,
      });
      this.logger.log(`🧹 Estado de análise limpo para ${phone}`);
    }
  }

  private async handleUpgradeFlow(phone: string, userId: string, userMessage: string, jurisdiction?: string): Promise<void> {
    try {
      console.log('🔄 Iniciando fluxo de upgrade com contexto...');
      
      // Verificar se há sessão ativa
      const activeSession = await this.upgradeSessionsService.getActiveSession(userId, jurisdiction);
      
      if (activeSession) {
        this.logger.log('🔄 Sessão ativa encontrada, continuando...');
        await this.continueUpgradeFlowWithContext(phone, userId, userMessage, activeSession);
      } else {
        this.logger.log('🆕 Nova sessão de upgrade iniciada');
        await this.startNewUpgradeFlow(phone, userId, userMessage, jurisdiction);
      }
    } catch (error) {
      this.logger.error('❌ Erro no fluxo de upgrade:', error);
      await this.sendMessage(phone, '❌ Erro no processo de upgrade. Tente novamente.');
    }
  }

  private async startNewUpgradeFlow(phone: string, userId: string, userMessage: string, forcedJurisdiction?: string): Promise<void> {
    try {
      this.logger.log('🆕 Iniciando novo fluxo de upgrade...');
      
      // Apenas PT/ES têm fluxo conversacional de upgrade
      const jurisdiction = forcedJurisdiction || this.jurisdictionService.detectJurisdiction(phone).jurisdiction;
      if (jurisdiction === 'BR') {
        const response = '🚀 Para fazer upgrade do seu plano, acesse: https://plataforma.lawx.ai/\n\n' +
          'Lá você encontrará os planos disponíveis e poderá concluir o upgrade com segurança.';
        await this.sendMessage(phone, response);
        return;
      }
      
      // Verificar se a mensagem já especifica um plano
      const selectedPlanName = await this.detectPlanFromMessage(userMessage, jurisdiction);
      
      if (selectedPlanName) {
        // Usuário já especificou o plano
        this.logger.log('📋 Plano especificado na mensagem, processando...');
        await this.processPlanSelection(phone, userId, userMessage);
      } else {
        // Perguntar sobre o plano
        this.logger.log('❓ Perguntando sobre plano...');
        const plans = await this.getUpgradePlans(jurisdiction);
        
        const planOptions = plans.map(plan => {
          const discount = plan.yearly_price < (plan.monthly_price * 12) 
            ? ` (${Math.round(((plan.monthly_price * 12 - plan.yearly_price) / (plan.monthly_price * 12)) * 100)}% de desconto)`
            : '';
          
          return `${plan.name === 'Pro' ? '🟢' : '🟡'} **PLANO ${plan.name.toUpperCase()} - R$ ${plan.monthly_price.toFixed(2)}/mês**\n• ${plan.description}${discount}`;
        }).join('\n\n');

        const upgradeMessage = `🚀 **Vamos fazer upgrade de plano!**

Escolha o plano que melhor atende suas necessidades:

${planOptions}

💡 **Recomendamos o plano anual** - Você economiza mais!

💬 **Digite:** "${plans.map(p => p.name).join('" ou "')}" para escolher seu plano`;

        await this.sendMessage(phone, upgradeMessage);
        
        // Criar sessão inicial
        const user = await this.usersService.getOrCreateUser(phone);
        if (user) {
        await this.upgradeSessionsService.createSession({
          user_id: userId,
          phone: phone,
          plan_name: '',
          billing_cycle: 'monthly',
          amount: 0,
            current_step: 'plan_selection',
            jurisdiction
        });
        }
      }
    } catch (error) {
      this.logger.error('❌ Erro ao iniciar fluxo de upgrade:', error);
      await this.sendMessage(phone, '❌ Erro no processo de upgrade. Tente novamente.');
    }
  }

  private async continueUpgradeFlowWithContext(phone: string, userId: string, userMessage: string, session: any): Promise<void> {
    try {
      const lowerMessage = userMessage.toLowerCase();
      
      // Verificar se é um retry
      if (lowerMessage.includes('tente novamente') || lowerMessage.includes('tentar novamente')) {
        this.logger.log('🔄 Retry detectado, continuando com sessão existente...');
        await this.handleRetry(phone, userId, session);
        return;
      }
      
      // Verificar se quer cancelar
      if (lowerMessage.includes('cancelar') || lowerMessage.includes('cancel')) {
        this.logger.log('❌ Cancelamento detectado...');
        await this.upgradeSessionsService.cancelSession(session.id);
        await this.sendMessage(phone, '❌ Upgrade cancelado. Você pode iniciar novamente quando quiser.');
        this.clearConversationState(phone);
        return;
      }
      
      // Verificar se quer mudar de plano
      if (lowerMessage.includes('pro') || lowerMessage.includes('premium')) {
        this.logger.log('🔄 Mudança de plano detectada...');
        await this.processPlanSelection(phone, userId, userMessage, session);
        return;
      }
      
      // Verificar se quer confirmar pagamento (PRIORIDADE MÁXIMA)
      if (lowerMessage.includes('sim') || lowerMessage.includes('quero') || 
          lowerMessage.includes('prosseguir') || lowerMessage.includes('pagar')) {
        this.logger.log('💳 Confirmação de pagamento detectada...');
        const state = this.getConversationState(phone);
        if (state.selectedPlan && state.selectedFrequency) {
          await this.finalizeUpgrade(phone, userId, state);
        } else {
          await this.sendMessage(phone, '❌ Informações do plano incompletas. Digite "quero assinar" para começar novamente.');
        }
        return;
      }
      
      // Verificar se está escolhendo frequência
      if (lowerMessage.includes('mensal') || lowerMessage.includes('anual') || 
          lowerMessage.includes('monthly') || lowerMessage.includes('yearly') ||
          lowerMessage.includes('mês') || lowerMessage.includes('ano')) {
        this.logger.log('📅 Seleção de frequência detectada...');
        await this.processFrequencySelection(phone, userId, userMessage);
        return;
      }
      
      // Se chegou aqui, não entendeu o comando
      await this.sendMessage(phone, '❓ Não entendi. Você pode:\n• Digite "Pro" ou "Premium" para escolher plano\n• Digite "mensal" ou "anual" para escolher frequência\n• Digite "cancelar" para cancelar');
      
    } catch (error) {
      console.error('❌ Erro ao continuar fluxo com contexto:', error);
      await this.sendMessage(phone, '❌ Erro no processo. Tente novamente.');
    }
  }

  private async handleRetry(phone: string, userId: string, session: any): Promise<void> {
    try {
      const retryMessage = await this.upgradeSessionsService.getRetryMessage(session);
      await this.sendMessage(phone, retryMessage);
      
      // Atualizar passo para pix_generation
      await this.upgradeSessionsService.updateStep(session.id, 'pix_generation');
      
      // Gerar PIX novamente
      const upgradeRequest = {
        user_id: userId,
        plan_name: session.plan_name,
        billing_cycle: session.billing_cycle,
        amount: session.amount,
        payment_method: 'pix' as const,
        status: 'pending' as const
      };
      
      try {
        // TODO: Implementar pagamento via Stripe para Chat LawX
        // const pixData = await this.mercadoPagoService.createPixPayment(upgradeRequest);
        // const pixMessages = await this.mercadoPagoService.sendPixQRCode(phone, pixData, upgradeRequest);
        
        // Incrementar tentativas
        await this.upgradeSessionsService.incrementAttempts(session.id);
        
        // TODO: Implementar envio de mensagens PIX para Chat LawX
        // await this.sendMessage(phone, pixMessages.mainMessage);
        // await this.sendImage(phone, pixMessages.qrCodeImage, `QR Code PIX - R$ ${upgradeRequest.amount.toFixed(2)}`);
        // await this.sendMessage(phone, pixMessages.copyPasteCode);
        // await this.sendMessage(phone, pixMessages.copyPasteInstructions);
        
        await this.sendMessage(phone, '💳 Redirecionando para pagamento via Stripe...');
        
        // Atualizar passo
        await this.upgradeSessionsService.updateStep(session.id, 'payment_pending');
        
      } catch (pixError) {
        console.error('❌ Erro ao gerar PIX no retry:', pixError);
        
        // Incrementar tentativas
        await this.upgradeSessionsService.incrementAttempts(session.id);
        
        // Enviar mensagem de erro com opções de recuperação
        const errorMessage = await this.upgradeSessionsService.getErrorRecoveryMessage(session);
        await this.sendMessage(phone, errorMessage);
      }
      
    } catch (error) {
      console.error('❌ Erro no retry:', error);
      await this.sendMessage(phone, '❌ Erro ao tentar novamente. Tente iniciar o processo novamente.');
    }
  }

  private async processPlanSelection(phone: string, userId: string, userMessage: string, existingSession?: any): Promise<void> {
    try {
      let jurisdiction = this.resolveUpgradeJurisdiction(phone, existingSession);
      const selectedPlanName = await this.detectPlanFromMessage(userMessage, jurisdiction);
      this.logger.log('🔍 Plano selecionado:', selectedPlanName);
      this.logger.log('🔍 Jurisdição:', jurisdiction);
      
      if (!selectedPlanName) {
        const plans = await this.getUpgradePlans(jurisdiction);
        const planNames = plans.map(p => p.name).join(' ou ');
        const isES = jurisdiction === 'ES';
        await this.sendMessage(phone, isES ? `❓ ¿Qué plan te gustaría? ${planNames}?` : `❓ Qual plano você gostaria? ${planNames}?`);
        return;
      }
      
      // Buscar dados do plano selecionado
      const selectedPlan = await this.getPlanByName(selectedPlanName);
      
      // Perguntar sobre frequência de pagamento
      const hasDiscount = selectedPlan.yearly_price < (selectedPlan.monthly_price * 12);
      const isES = jurisdiction === 'ES';
      const currency = (jurisdiction === 'ES' || jurisdiction === 'PT') ? '€' : 'R$';
      const discountText = hasDiscount
        ? ` (${Math.round(((selectedPlan.monthly_price * 12 - selectedPlan.yearly_price) / (selectedPlan.monthly_price * 12)) * 100)}% ${isES ? 'de descuento' : 'de desconto'})`
        : '';
      const monthlyLabel = isES ? 'Mensual' : 'Mensal';
      const monthWord = isES ? 'mes' : 'mês';
      const annualLabel = isES ? 'Anual' : 'Anual';
      const header = isES ? `✅ *Plan seleccionado: ${selectedPlan.name}*` : `✅ *Plano selecionado: ${selectedPlan.name}*`;
      const chooseFreq = isES ? 'Ahora, elige la frecuencia de pago:' : 'Agora escolha a frequência de pagamento:';
      const recommend = isES ? '💡 *Recomendamos el plan anual* - ¡Ahorras más!' : '💡 *Recomendamos o plano anual* - Você economiza mais!';
      const ask = isES ? '¿Cuál frecuencia prefieres?' : 'Qual a frequência de pagamento ideal para você?';

      const frequencyMessage = `${header}

${chooseFreq}

🟢 *${monthlyLabel}:* ${currency} ${selectedPlan.monthly_price.toFixed(2)}/${monthWord}
🟢 *${annualLabel}:* ${currency} ${selectedPlan.yearly_price.toFixed(2)}/${isES ? 'año' : 'ano'}${discountText}

${recommend}`;

      await this.sendMessage(phone, frequencyMessage);
      await this.sendMessage(phone, ask);
      
      // Criar ou atualizar sessão com apenas o plano selecionado
      let session = existingSession;
      if (session) {
        session = await this.upgradeSessionsService.updateSession(existingSession.id, {
          plan_name: selectedPlan.name,
          current_step: 'plan_selection'
        });
      } else {
        // Tentar reaproveitar sessão ativa existente
        session = await this.upgradeSessionsService.getActiveSession(userId, jurisdiction);
      }

      if (!session) {
        const user = await this.usersService.getOrCreateUser(phone);
        if (user) {
        session = await this.upgradeSessionsService.createSession({
          user_id: userId,
          phone: phone,
          plan_name: selectedPlan.name,
            billing_cycle: 'monthly',
            amount: 0,
            current_step: 'plan_selection',
            jurisdiction,
        });
        }
      }
      
      // Atualizar estado da conversa
      const state = this.getConversationState(phone);
      state.isInUpgradeFlow = true;
      state.upgradeStep = 'plan_selection';
      state.selectedPlan = selectedPlan.name;
      // Não definir selectedFrequency ainda
      this.setConversationState(phone, state);
      
    } catch (error) {
      console.error('❌ Erro ao processar seleção de plano:', error);
      await this.sendMessage(phone, '❌ Erro ao processar seleção. Tente novamente.');
    }
  }

  private async processFrequencySelection(phone: string, userId: string, userMessage: string): Promise<void> {
    try {
      const jurisdiction = this.resolveUpgradeJurisdiction(phone);
      const user = await this.usersService.getOrCreateUser(phone, jurisdiction);
      if (!user) {
        const isESnf = jurisdiction === 'ES';
        await this.sendMessage(phone, isESnf ? '❌ Usuario no encontrado.' : '❌ Usuário não encontrado.');
        return;
      }

      // Detectar frequência com IA
      let billingCycle: 'monthly' | 'yearly' | null = null;
      const isES = jurisdiction === 'ES';

      const freqAnalysis = await this.aiService.detectPlanFrequencySelection(userMessage);
      if (freqAnalysis.frequency && freqAnalysis.confidence >= 0.6) {
        billingCycle = freqAnalysis.frequency;
      } else {
        // Fallback: pedir esclarecimento no idioma
        await this.sendMessage(
          phone,
          isES
            ? '❓ No entendí la frecuencia. ¿Prefieres pago "mensual" o "anual"?'
            : '❓ Não entendi a frequência. Prefere pagamento "mensal" ou "anual"?'
        );
        return;
      }
      
      // Buscar sessão ativa
      const session = await this.upgradeSessionsService.getActiveSession(userId, jurisdiction);
      if (!session) {
        await this.sendMessage(phone, isES ? '❌ Sesión no encontrada. Escribe "quiero suscribirme" para comenzar de nuevo.' : '❌ Sessão não encontrada. Digite "quero assinar" para começar novamente.');
        return;
      }

      // Garantir que há um plano selecionado antes de processar a frequência
      let planName = session.plan_name;
      if (!planName) {
        const state = this.getConversationState(phone);
        if (state?.selectedPlan) {
          // Atualizar sessão com plano do estado
          await this.upgradeSessionsService.updateSession(session.id, {
            plan_name: state.selectedPlan,
            current_step: 'plan_selection',
          });
          planName = state.selectedPlan;
        } else {
          const plans = await this.getUpgradePlans(jurisdiction);
          const planNames = plans.map(p => p.name).join(isES ? ' o ' : ' ou ');
          await this.sendMessage(
            phone,
            isES
              ? `❓ Antes de elegir la frecuencia, dime el plan: ${planNames}?`
              : `❓ Antes de escolher a frequência, informe o plano: ${planNames}?`
          );
          // Colocar estado em seleção de plano
          const newState = this.getConversationState(phone);
          newState.isInUpgradeFlow = true;
          newState.upgradeStep = 'plan_selection';
          this.setConversationState(phone, newState);
          return;
        }
      }
      
      // Buscar dados do plano para calcular preço
      const plan = await this.getPlanByName(planName);
      const planPrice = billingCycle === 'monthly' ? plan.monthly_price : plan.yearly_price;
      
      // Atualizar sessão com frequência e preço
      const updatedSession = await this.upgradeSessionsService.updateSession(session.id, {
        billing_cycle: billingCycle,
        amount: planPrice,
        current_step: 'payment_info'
      });
      
      // Buscar limites do plano
      const planLimits = await this.getPlanLimits(plan.name, user.jurisdiction || jurisdiction);
      
      // Enviar confirmação
      const currency = (jurisdiction === 'ES' || jurisdiction === 'PT') ? '€' : 'R$';
      const confirmationMessage = isES
        ? `✅ **Confirmación del pedido:**

📋 **Plan:** ${plan.name}
💰 **Frecuencia:** ${billingCycle === 'monthly' ? 'Mensual' : 'Anual'}
💵 **Valor:** ${currency} ${planPrice.toFixed(2)}

🚀 **Lo que tendrás:**
${planLimits}

💳 **Arriba están todas las informaciones de tu plan**`
        : `✅ **Confirmação do pedido:**

📋 **Plano:** ${plan.name}
💰 **Frequência:** ${billingCycle === 'monthly' ? 'Mensal' : 'Anual'}
💵 **Valor:** ${currency} ${planPrice.toFixed(2)}

🚀 **O que você terá:**
${planLimits}

💳 **Acima estão todas as informações do seu plano**`;

      await this.sendMessage(phone, confirmationMessage);
      await this.sendMessage(phone, isES
        ? '¿Puedo generar tu pago? Por ahora no aceptamos tarjeta de crédito, pero aceptamos PIX.'
        : 'Posso gerar seu pagamento? No momento não temos suporte a cartão de crédito, mas aceitamos PIX.'
      );
      
      // Atualizar estado da conversa
      const state = this.getConversationState(phone);
      state.isInUpgradeFlow = true;
      state.upgradeStep = 'payment_info';
      state.selectedPlan = session.plan_name;
      state.selectedFrequency = billingCycle;
      this.setConversationState(phone, state);
      
    } catch (error) {
      console.error('❌ Erro ao processar seleção de frequência:', error);
      await this.sendMessage(phone, '❌ Erro ao processar seleção. Tente novamente.');
    }
  }

  private async finalizeUpgrade(phone: string, userId: string, state: ConversationState): Promise<void> {
    try {
      // Buscar dados do plano para calcular preço
      const plan = await this.getPlanByName(state.selectedPlan);
      const planPrice = state.selectedFrequency === 'monthly' ? plan.monthly_price : plan.yearly_price;
      
      const response = `🎉 **Excelente decisão! Vamos te ajudar na sua organização financeira!**

✅ **Resumo do Pedido:**
• Plano: ${state.selectedPlan}
• Frequência: ${state.selectedFrequency === 'monthly' ? 'Mensal' : 'Anual'}
• Valor: R$ ${planPrice.toFixed(2)}

⏳ **Gerando PIX...**
Aguarde um momento enquanto preparamos seu pagamento... ⏳`;
      
      await this.sendMessage(phone, response);
      
      // Buscar ou criar sessão
      let session = await this.upgradeSessionsService.getActiveSession(userId);
      
      if (!session) {
        // Criar nova sessão
        session = await this.upgradeSessionsService.createSession({
          user_id: userId,
          phone: phone,
          plan_name: state.selectedPlan,
          billing_cycle: state.selectedFrequency,
          amount: planPrice,
          current_step: 'payment_processing'
        });
      } else {
        // Atualizar sessão existente
        session = await this.upgradeSessionsService.updateSession(session.id, {
          plan_name: state.selectedPlan,
          billing_cycle: state.selectedFrequency,
          amount: planPrice,
          current_step: 'payment_processing'
        });
      }
      
      // Gerar JSON para requisição
      const upgradeRequest = {
        user_id: userId,
        plan_name: state.selectedPlan,
        billing_cycle: state.selectedFrequency,
        amount: planPrice,
        payment_method: 'pix' as const,
        status: 'pending' as const
      };
      
      console.log('📋 JSON para requisição:', JSON.stringify(upgradeRequest, null, 2));
      
      // Gerar PIX via Mercado Pago
      try {
        // TODO: Implementar pagamento via Stripe para Chat LawX
        // const pixData = await this.mercadoPagoService.createPixPayment(upgradeRequest);
        // const pixMessages = await this.mercadoPagoService.sendPixQRCode(phone, pixData, upgradeRequest);
        
        // TODO: Implementar envio de mensagens PIX para Chat LawX
        // await this.sendMessage(phone, pixMessages.mainMessage);
        // await this.sendImage(phone, pixMessages.qrCodeImage, `QR Code PIX - R$ ${upgradeRequest.amount.toFixed(2)}`);
        // await this.sendMessage(phone, pixMessages.copyPasteCode);
        // await this.sendMessage(phone, pixMessages.copyPasteInstructions);
        
        await this.sendMessage(phone, '💳 Redirecionando para pagamento via Stripe...');
        
        // Atualizar sessão para payment_pending
        await this.upgradeSessionsService.updateStep(session.id, 'payment_pending');
        
      } catch (pixError) {
        console.error('❌ Erro ao gerar PIX:', pixError);
        
        // Incrementar tentativas
        await this.upgradeSessionsService.incrementAttempts(session.id);
        
        // Enviar mensagem de erro com opções de recuperação
        const errorMessage = await this.upgradeSessionsService.getErrorRecoveryMessage(session);
        await this.sendMessage(phone, errorMessage);
      }
      
      // Limpar estado da conversa
      this.clearConversationState(phone);
      
    } catch (error) {
      console.error('❌ Erro ao finalizar upgrade:', error);
      await this.sendMessage(phone, '❌ Erro ao processar upgrade. Tente novamente.');
    }
  }


  private async processAudioViaEvolutionAPI(message: any): Promise<Buffer | null> {
    try {
      this.logger.log('🎵 Processando áudio via Evolution API...');
      
      // Log da estrutura completa da mensagem para debug
      this.logger.log('🔍 Estrutura da mensagem:', JSON.stringify(message, null, 2));
      
      // Usar Evolution API para baixar o áudio
      this.logger.log('🎵 Tentando download via Evolution API...');
      const audioBuffer = await this.mediaDownloader.downloadAudioFromMessage(message);
      
      if (!audioBuffer) {
        this.logger.error('❌ Falha ao baixar áudio via Evolution API');
        return null;
      }

      this.logger.log('✅ Áudio baixado com sucesso via Evolution API:', audioBuffer.length, 'bytes');
      
      // Verificar os primeiros bytes para debug
      const firstBytes = audioBuffer.slice(0, 16);
      this.logger.log('🔍 Primeiros bytes do arquivo:', firstBytes.toString('hex'));
      
      // Converter para MP3 para melhor compatibilidade
      const mp3Buffer = await this.audioProcessor.convertToMp3WithFallback(audioBuffer);
        this.logger.log('✅ Áudio convertido para MP3:', mp3Buffer.length, 'bytes');
        return mp3Buffer;

    } catch (error) {
      this.logger.error('❌ Erro ao processar áudio via Evolution API:', error);
      return null;
    }
  }

  private async processAudioBase64(message: any): Promise<Buffer | null> {
    try {
      this.logger.log('🎵 Processando áudio base64...');
      
      // Log da estrutura completa da mensagem para debug
      this.logger.log('🔍 Estrutura da mensagem:', JSON.stringify(message, null, 2));

      // Verificar se temos base64 na mensagem (nível da mensagem, não dentro de audioMessage)
      if (message.message?.base64) {
        this.logger.log('✅ Base64 encontrado na mensagem');
        const buffer = Buffer.from(message.message?.base64, 'base64');
        
        if (buffer.length === 0) {
          this.logger.error('❌ Buffer vazio após conversão base64');
          return null;
        }

        this.logger.log('✅ Áudio convertido de base64:', buffer.length, 'bytes');
        
        // Verificar os primeiros bytes para debug
        const firstBytes = buffer.slice(0, 16);
        this.logger.log('🔍 Primeiros bytes do arquivo:', firstBytes.toString('hex'));
        
        // Converter para MP3 para melhor compatibilidade
        try {
          const mp3Buffer = await this.audioProcessor.convertToMp3WithFallback(buffer);
          this.logger.log('✅ Áudio convertido para MP3:', mp3Buffer.length, 'bytes');
          return mp3Buffer;
        } catch (conversionError) {
          this.logger.warn('⚠️ Falha na conversão para MP3, tentando conversão simples:', conversionError.message);
          try {
            return buffer;
          } catch (simpleError) {
            this.logger.warn('⚠️ Falha na conversão simples, usando buffer original:', simpleError.message);
            return buffer;
          }
        }
      } else {
        this.logger.log('⚠️ Base64 não encontrado no nível da mensagem');
        this.logger.log('🔍 Verificando se base64 está em message.base64...');
        
        // Verificar se base64 está em message.message.base64
        if (message.message?.base64) {
          this.logger.log('✅ Base64 encontrado em message.message.base64');
          const buffer = Buffer.from(message.message.base64, 'base64');
          
          if (buffer.length === 0) {
            this.logger.error('❌ Buffer vazio após conversão base64');
            return null;
          }

          this.logger.log('✅ Áudio convertido de base64:', buffer.length, 'bytes');
          
          // Verificar os primeiros bytes para debug
          const firstBytes = buffer.slice(0, 16);
          this.logger.log('🔍 Primeiros bytes do arquivo:', firstBytes.toString('hex'));
          
          // Converter para MP3 para melhor compatibilidade
          try {
          const mp3Buffer = await this.audioProcessor.convertToMp3WithFallback(buffer);
            this.logger.log('✅ Áudio convertido para MP3:', mp3Buffer.length, 'bytes');
            return mp3Buffer;
          } catch (conversionError) {
            this.logger.warn('⚠️ Falha na conversão para MP3, tentando conversão simples:', conversionError.message);
            try {
              return buffer;
            } catch (simpleError) {
              this.logger.warn('⚠️ Falha na conversão simples, usando buffer original:', simpleError.message);
              return buffer;
            }
          }
        }
      }

      // Fallback: tentar download se não houver base64
      this.logger.log('⚠️ Base64 não encontrado, tentando download...');
      return await this.downloadAudio(message);

    } catch (error) {
      this.logger.error('❌ Erro ao processar áudio base64:', error);
      return null;
    }
  }

  private async downloadAudio(messageData: any): Promise<Buffer> {
    try {
      this.logger.log('🎵 Iniciando download de áudio...');
      const buf = await this.mediaDownloader.downloadAudioFromMessage(messageData);
      if (buf && buf.length > 0) return buf;
      throw new Error('Não foi possível baixar o áudio');

    } catch (error) {
      this.logger.error('❌ Erro ao baixar áudio:', error);
      throw error;
    }
  }

  private async downloadFromEvolutionMediaAPI(audioMessage: any): Promise<Buffer | null> {
    try {
      const evolutionApiUrl = this.configService.get('EVOLUTION_API_URL');
      const evolutionApiKey = this.configService.get('EVOLUTION_API_KEY');
      const instanceName = this.configService.get('EVOLUTION_INSTANCE_NAME');

      const messageId = audioMessage.message.key.id;
      this.logger.log('🎵 ID da mensagem extraído:', messageId);

      // Método 1: Tentar usar a API de download de mídia do Evolution API
      try {
        const response = await fetch(`${evolutionApiUrl}/chat/getBase64FromMediaMessage/${instanceName}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': evolutionApiKey,
          },
          body: JSON.stringify({
            message: {
              key: {
                id: messageId
              }
            },
            convertToMp4: true
          }),
        });

        if (response.ok) {
          const result = await response.json();
          
          if (result.base64) {
            this.logger.log('✅ Áudio baixado via Evolution API Media Download');
            const buffer = Buffer.from(result.base64, 'base64');
            
            // Verificar se o buffer é válido
            if (buffer.length === 0) {
              throw new Error('Arquivo de áudio vazio');
            }

            this.logger.log('✅ Áudio baixado com sucesso:', buffer.length, 'bytes');
            
            // Verificar os primeiros bytes para debug
            const firstBytes = buffer.slice(0, 16);
            this.logger.log('🔍 Primeiros bytes do arquivo:', firstBytes.toString('hex'));
            
            return buffer;
          }
        }
      } catch (apiError) {
        this.logger.warn('⚠️ API getBase64FromMediaMessage não disponível, tentando método alternativo...');
      }

      // Método 2: Tentar usar a API de download direto
      try {
        const response = await fetch(`${evolutionApiUrl}/chat/downloadMedia/${instanceName}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': evolutionApiKey,
          },
          body: JSON.stringify({
            url: audioMessage.url,
            mimetype: audioMessage.mimetype,
            mediaKey: audioMessage.mediaKey,
            fileEncSha256: audioMessage.fileEncSha256,
            fileSha256: audioMessage.fileSha256,
            fileLength: audioMessage.fileLength,
            seconds: audioMessage.seconds,
            ptt: audioMessage.ptt,
            directPath: audioMessage.directPath,
            mediaKeyTimestamp: audioMessage.mediaKeyTimestamp,
            streamingSidecar: audioMessage.streamingSidecar,
            waveform: audioMessage.waveform
          }),
        });

        if (response.ok) {
          const buffer = await response.arrayBuffer();
          const nodeBuffer = Buffer.from(buffer);
          
          if (nodeBuffer.length > 0) {
            this.logger.log('✅ Áudio baixado via Evolution API Download Media');
            this.logger.log('✅ Áudio baixado com sucesso:', nodeBuffer.length, 'bytes');
            
            // Verificar os primeiros bytes para debug
            const firstBytes = nodeBuffer.slice(0, 16);
            this.logger.log('🔍 Primeiros bytes do arquivo:', firstBytes.toString('hex'));
            
            return nodeBuffer;
          }
        }
      } catch (downloadError) {
        this.logger.warn('⚠️ API downloadMedia não disponível:', downloadError.message);
      }

      return null;

    } catch (error) {
      this.logger.error('❌ Erro no download via Evolution API Media Download:', error);
      return null;
    }
  }

  private async processUpgradeFlowWithAI(phone: string, userId: string, userMessage: string, session: any, state: ConversationState): Promise<void> {
    try {
      this.logger.log('🧠 Processando fluxo de upgrade com IA...');
      this.logger.log('📋 Sessão:', session);
      this.logger.log('📋 Estado:', state);

      // Construir contexto para análise
      const context = {
        currentStep: session?.current_step || state.upgradeStep,
        selectedPlan: session?.plan_name || state.selectedPlan,
        selectedFrequency: session?.billing_cycle || state.selectedFrequency,
        amount: session?.amount || 0,
        sessionId: session?.id
      };

      // Usar IA para analisar a intenção no contexto
      const aiAnalysis = await this.aiService.analyzePlanUpgradeIntent(userMessage, context);
      
      this.logger.log('🤖 Análise da IA:', aiAnalysis);

      // Processar baseado na intenção detectada
      // Mantido por compatibilidade; Engine já cobre o fluxo principal
      await this.upgradeFlowEngine.route(phone, userId, userMessage, session, state, {
        handlePaymentConfirmation: (p, u, ctx) => this.handlePaymentConfirmation(p, u, ctx),
        handleFrequencySelectionWithAI: (p, u, m, ctx) => this.handleFrequencySelectionWithAI(p, u, m, ctx),
        handlePlanSelectionWithAI: (p, u, m, ctx) => this.handlePlanSelectionWithAI(p, u, m, ctx),
        handleCancelUpgrade: (p, u, s) => this.handleCancelUpgrade(p, u, s),
        handleContinueUpgrade: (p, u, m, ctx) => this.handleContinueUpgrade(p, u, m, ctx),
      });

    } catch (error) {
      this.logger.error('❌ Erro ao processar fluxo de upgrade com IA:', error);
      await this.sendMessage(phone, '❌ Erro no processo. Tente novamente.');
    }
  }

  private async handlePaymentConfirmation(phone: string, userId: string, context: any): Promise<void> {
    try {
      this.logger.log('💳 Processando confirmação de pagamento...');
      
      // Verificar se temos todas as informações necessárias
      if (!context.selectedPlan || !context.selectedFrequency) {
        const jurisdiction = this.resolveUpgradeJurisdiction(phone);
        const isES = jurisdiction === 'ES';
        await this.sendMessage(phone, isES ? '❌ Información del plan incompleta. Escribe "quiero suscribirme" para empezar de nuevo.' : '❌ Informações do plano incompletas. Digite "quero assinar" para começar novamente.');
        return;
      }

      // Buscar dados do plano para calcular preço
      const plan = await this.getPlanByName(context.selectedPlan);
      const planPrice = context.selectedFrequency === 'monthly' ? plan.monthly_price : plan.yearly_price;
      const jurisdiction = this.resolveUpgradeJurisdiction(phone);
      const isES = jurisdiction === 'ES';

      // Buscar ou criar sessão e gerar Checkout do Stripe
      let session = await this.upgradeSessionsService.getActiveSession(userId, jurisdiction);
      if (!session) {
        session = await this.upgradeSessionsService.createSession({
          user_id: userId,
          phone: phone,
          plan_name: context.selectedPlan,
          billing_cycle: context.selectedFrequency as 'monthly' | 'yearly',
          amount: planPrice,
          current_step: 'payment_processing',
          jurisdiction,
        });
      } else {
        session = await this.upgradeSessionsService.updateSession(session.id, {
          plan_name: context.selectedPlan,
          billing_cycle: context.selectedFrequency as 'monthly' | 'yearly',
          amount: planPrice,
          current_step: 'payment_processing',
        });
      }

      const { checkoutUrl } = await this.upgradeSessionsService.createStripeCheckoutSession(
        userId,
        context.selectedPlan,
        context.selectedFrequency,
        phone,
        undefined // coletar e-mail no checkout
      );

      const currency = (jurisdiction === 'ES' || jurisdiction === 'PT') ? '€' : 'R$';
      // Gerar mensagem localizada com IA contendo todas as informações da assinatura
      try {
        const features = Array.isArray((plan as any).features)
          ? (plan as any).features.join('\n• ')
          : '';
        const prompt = `Gere uma mensagem de confirmação de pagamento para o Chat LawX (assistente jurídico) com tom profissional e claro.

Idioma: ${getJurisdictionLanguage(jurisdiction)}
Jurisdição: ${getJurisdiction(jurisdiction)}

Informações obrigatórias a incluir (formate com negrito nos títulos e bullets quando fizer sentido):
- Plano: ${context.selectedPlan}
- Frequência: ${context.selectedFrequency === 'monthly' ? (isES ? 'Mensual' : 'Mensal') : (isES ? 'Anual' : 'Anual')}
- Valor: ${currency} ${planPrice.toFixed(2)}
- Principais funcionalidades do plano (se houver): ${features ? '\n• ' + features : 'não especificado'}
- Link seguro para pagamento (CTA claro): ${checkoutUrl}
- Observação curta sobre segurança (Stripe Checkout) e coleta de email no checkout

Regras de saída:
- Use obrigatoriamente ${isES ? 'Espanhol' : 'Português europeu'}.
- Máximo 8 linhas.
- Não invente informações não fornecidas.
- Não inclua dados sensíveis.`;

        const aiMsg = await this.aiGateway.executeCustomPrompt(
          prompt,
          'gpt-4o-mini',
          'Você é um redator que prepara mensagens curtas e claras de confirmação de pagamento, mantendo apenas fatos fornecidos.',
          0.4,
          450
        );

        await this.sendMessage(phone, aiMsg);
      } catch (genErr) {
        this.logger.warn('Falha ao gerar mensagem com IA, usando fallback simples. Detalhe:', genErr);
        const fallback = isES
          ? `💳 **Listo para pagar!**\n\n📋 **Plan:** ${context.selectedPlan}\n⏱️ **Frecuencia:** ${context.selectedFrequency === 'monthly' ? 'Mensual' : 'Anual'}\n💵 **Valor:** ${currency} ${planPrice.toFixed(2)}\n\n✅ **Haz clic para completar el pago de forma segura:**\n${checkoutUrl}`
          : `💳 **Pronto para pagar!**\n\n📋 **Plano:** ${context.selectedPlan}\n⏱️ **Frequência:** ${context.selectedFrequency === 'monthly' ? 'Mensal' : 'Anual'}\n💵 **Valor:** ${currency} ${planPrice.toFixed(2)}\n\n✅ **Clique para finalizar o pagamento com segurança:**\n${checkoutUrl}`;
        await this.sendMessage(phone, fallback);
      }
      
    } catch (error) {
      this.logger.error('❌ Erro ao processar confirmação de pagamento:', error);
      const jurisdiction = this.resolveUpgradeJurisdiction(phone);
      await this.sendMessage(phone, jurisdiction === 'ES' ? '❌ Error al procesar el pago. Inténtalo de nuevo.' : '❌ Erro ao processar pagamento. Tente novamente.');
    }
  }

  private async handleFrequencySelectionWithAI(phone: string, userId: string, userMessage: string, context: any): Promise<void> {
    try {
      this.logger.log('📅 Processando seleção de frequência com IA...');
      
      // Usar IA para detectar frequência
      const frequencyAnalysis = await this.aiService.detectPlanFrequencySelection(userMessage);
      
      if (frequencyAnalysis.frequency) {
        await this.processFrequencySelection(phone, userId, userMessage);
      } else {
        await this.sendMessage(phone, '❓ Escolha a frequência: "mensal" ou "anual"?');
      }
      
    } catch (error) {
      this.logger.error('❌ Erro ao processar seleção de frequência:', error);
      await this.sendMessage(phone, '❌ Erro ao processar seleção. Tente novamente.');
    }
  }

  private async handlePlanSelectionWithAI(phone: string, userId: string, userMessage: string, context: any): Promise<void> {
    try {
      this.logger.log('📋 Processando seleção de plano com IA...');
      
      // Usar IA para detectar plano
      const planAnalysis = await this.aiService.detectPlanFromMessage(userMessage);
      
      if (planAnalysis.planName) {
        await this.processPlanSelection(phone, userId, userMessage, context?.session);
      } else {
        const jurisdiction = context?.session?.jurisdiction || this.jurisdictionService.detectJurisdiction(phone).jurisdiction;
        const plans = await this.getUpgradePlans(jurisdiction);
        const planNames = plans.map(p => p.name).join(' ou ');
        await this.sendMessage(phone, `❓ Qual plano você gostaria? ${planNames}?`);
      }
      
    } catch (error) {
      this.logger.error('❌ Erro ao processar seleção de plano:', error);
      await this.sendMessage(phone, '❌ Erro ao processar seleção. Tente novamente.');
    }
  }

  private async handleCancelUpgrade(phone: string, userId: string, session: any): Promise<void> {
    try {
      this.logger.log('❌ Processando cancelamento de upgrade...');
      
      if (session) {
        await this.upgradeSessionsService.cancelSession(session.id);
      }
      
      this.clearConversationState(phone);
      await this.sendMessage(phone, '❌ Upgrade cancelado. Você pode iniciar novamente quando quiser.');
      
    } catch (error) {
      this.logger.error('❌ Erro ao processar cancelamento:', error);
      await this.sendMessage(phone, '❌ Erro ao cancelar. Tente novamente.');
    }
  }

  private async handleContinueUpgrade(phone: string, userId: string, userMessage: string, context: any): Promise<void> {
    try {
      this.logger.log('🔄 Continuando fluxo de upgrade...');
      
      // Gerar resposta contextual baseada no estado atual
      const response = await this.aiService.generatePlanUpgradeResponse(userMessage, context);
      await this.sendMessage(phone, response);
      
    } catch (error) {
      this.logger.error('❌ Erro ao continuar upgrade:', error);
      await this.sendMessage(phone, '❌ Erro no processo. Tente novamente.');
    }
  }

  private async generatePixPayment(phone: string, userId: string, planName: string, frequency: string, amount: number, session: any): Promise<void> {
    try {
      // Gerar JSON para requisição
      const upgradeRequest = {
        user_id: userId,
        plan_name: planName,
        billing_cycle: frequency as 'monthly' | 'yearly',
        amount: amount,
        payment_method: 'pix' as const,
        status: 'pending' as const
      };
      
      this.logger.log('📋 JSON para requisição:', JSON.stringify(upgradeRequest, null, 2));
      
      // Gerar PIX via Mercado Pago
      try {
        // TODO: Implementar pagamento via Stripe para Chat LawX
        // const pixData = await this.mercadoPagoService.createPixPayment(upgradeRequest);
        // const pixMessages = await this.mercadoPagoService.sendPixQRCode(phone, pixData, upgradeRequest);
        
        // TODO: Implementar envio de mensagens PIX para Chat LawX
        // await this.sendMessage(phone, pixMessages.mainMessage);
        // await this.sendImage(phone, pixMessages.qrCodeImage, `QR Code PIX - R$ ${upgradeRequest.amount.toFixed(2)}`);
        // await this.sendMessage(phone, pixMessages.copyPasteCode);
        // await this.sendMessage(phone, pixMessages.copyPasteInstructions);
        
        await this.sendMessage(phone, '💳 Redirecionando para pagamento via Stripe...');
        
        // Atualizar sessão para payment_pending
        await this.upgradeSessionsService.updateStep(session.id, 'payment_pending');
        
      } catch (pixError) {
        this.logger.error('❌ Erro ao gerar PIX:', pixError);
        
        // Incrementar tentativas
        await this.upgradeSessionsService.incrementAttempts(session.id);
        
        // Enviar mensagem de erro com opções de recuperação
        const errorMessage = await this.upgradeSessionsService.getErrorRecoveryMessage(session);
        await this.sendMessage(phone, errorMessage);
      }
      
      // Limpar estado da conversa
      this.clearConversationState(phone);
      
    } catch (error) {
      this.logger.error('❌ Erro ao gerar PIX:', error);
      await this.sendMessage(phone, '❌ Erro ao processar pagamento. Tente novamente.');
    }
  }

  // ===== FUNÇÕES AUXILIARES PARA PROCESSAMENTO DE DOCUMENTOS =====

  private extractBase64FromDocumentMessage(messageData: any): string | null {
    try {
      this.logger.log('📄 Extraindo base64 da mensagem de documento...');
      
      const documentMessage = messageData.message?.documentMessage;
      if (!documentMessage) {
        this.logger.warn('⚠️ Mensagem de documento não encontrada');
        return null;
      }

      this.logger.log('📄 Dados do documento:', JSON.stringify(documentMessage, null, 2));

      // Verificar se há base64 na mensagem
      if (messageData.message?.base64) {
        this.logger.log('✅ Base64 encontrado na mensagem');
        return messageData.message.base64;
      }

      // Verificar se há base64 no documentMessage
      if (documentMessage.base64) {
        this.logger.log('✅ Base64 encontrado no documentMessage');
        return documentMessage.base64;
      }

      this.logger.warn('⚠️ Base64 não encontrado na mensagem de documento');
      return null;
    } catch (error) {
      this.logger.error('❌ Erro ao extrair base64:', error);
      return null;
    }
  }

  private detectDocumentType(buffer: Buffer): string {
    const header = buffer.slice(0, 8);
    const headerHex = header.toString('hex').toLowerCase();
    
    this.logger.log('📄 Header do documento:', headerHex);
    
    // PDF: %PDF
    if (headerHex.startsWith('25504446')) {
      this.logger.log('📄 Tipo detectado: PDF');
      return 'application/pdf';
    }
    
    // DOCX: PK (ZIP-based)
    if (headerHex.startsWith('504b0304') || headerHex.startsWith('504b0506')) {
      this.logger.log('📄 Tipo detectado: DOCX');
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }
    
    // DOC: D0CF11E0 (OLE2)
    if (headerHex.startsWith('d0cf11e0')) {
      this.logger.log('📄 Tipo detectado: DOC');
      return 'application/msword';
    }
    
    this.logger.warn('⚠️ Tipo de documento não reconhecido:', headerHex);
    return 'unknown';
  }

  private isSupportedDocumentType(mimeType: string): boolean {
    const supportedTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    
    return supportedTypes.includes(mimeType);
  }

  private generateDocumentFileName(mimeType: string): string {
    const timestamp = Date.now();
    const extension = this.getFileExtensionFromMimeType(mimeType);
    return `document-${timestamp}.${extension}`;
  }

  private getFileExtensionFromMimeType(mimeType: string): string {
    const extensions: { [key: string]: string } = {
      'application/pdf': 'pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/msword': 'doc'
    };
    return extensions[mimeType] || 'bin';
  }

  private async convertBase64ToFile(base64Data: string, mimeType: string): Promise<Buffer> {
    try {
      // Remover prefixo data: se existir
      const base64 = base64Data.replace(/^data:[^;]+;base64,/, '');
      const buffer = Buffer.from(base64, 'base64');
      
      this.logger.log(`📄 Arquivo convertido: ${buffer.length} bytes, tipo: ${mimeType}`);
      return buffer;
    } catch (error) {
      this.logger.error('❌ Erro ao converter base64:', error);
      throw new Error('Falha na conversão do documento');
    }
  }

  private async analyzeDocumentWithExternalAPI(fileUrl: string, jurisdiction?: string): Promise<any> {
    try {
      this.logger.log('🔍 Enviando documento para análise externa...');
      
      // ✅ NOVO: Gerar prompt localizado baseado na jurisdição
      const promptText = this.generateLocalizedAnalysisPrompt(jurisdiction);
      
      const response = await axios.post(
        'https://us-central1-gleaming-nomad-443014-u2.cloudfunctions.net/vertex-LawX-personalizada',
        {
          prompt_text: promptText,
          file_url: fileUrl
        },
        {
          headers: {
            'Content-Type': 'application/json',
          }
        }
      );

      this.logger.log('✅ Análise externa concluída');

      // Verificar se a resposta é um JSON válido
      let analysisData;
      try {
        analysisData = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
      } catch (parseError) {
        this.logger.error('❌ Erro ao fazer parse do JSON:', parseError);
        throw new Error('Resposta inválida do serviço de análise');
      }

      // Retornar dados JSON para formatação posterior
      return analysisData;
    } catch (error) {
      this.logger.error('❌ Erro na análise externa:', error);
      
      if (error.response) {
        this.logger.error('❌ Status da resposta:', error.response.status);
        this.logger.error('❌ Dados da resposta:', error.response.data);
      }
      
      throw new Error('Falha na análise do documento. Tente novamente.');
    }
  }

  private checkAnalysisTimeout(conversationState: ConversationState): boolean {
    if (!conversationState.analysisStartTime) {
      return false;
    }
    
    const currentTime = Date.now();
    const timeElapsed = currentTime - conversationState.analysisStartTime;
    const timeoutMs = 10 * 60 * 1000; // 10 minutos em milissegundos
    
    return timeElapsed > timeoutMs;
  }

  /**
   * Processa confirmação de análise de documento
   */
  private async handleAnalysisConfirmation(message: any, phone: string, user: User | null, jurisdiction: string): Promise<void> {
    try {
      const text = message.message?.conversation || '';
      
      // Usar IA para detectar confirmação/negação
      const detection = await this.aiService.detectConfirmationOrDenial(text, jurisdiction);
      
      if (detection.isConfirmation && detection.confidence > 0.7) {
        // Usuário quer analisar outro documento
        await this.sendMessage(phone, this.getAnalysisConfirmationMessage(jurisdiction));
        // Manter isInAnalysis = true (já está definido)
        
      } else if (detection.isDenial && detection.confidence > 0.7) {
        // Usuário não quer analisar outro documento
        const conversationState = this.getConversationState(phone);
        this.setConversationState(phone, {
          ...conversationState,
          isInAnalysis: false,
          analysisStartTime: undefined
        });
        
        // Mostrar menu legal
        await this.showLegalMenu(phone, jurisdiction);
        
      } else {
        // Resposta não reconhecida ou confiança baixa
        await this.sendMessage(phone, this.getUnrecognizedResponseMessage(jurisdiction));
      }
      
    } catch (error) {
      this.logger.error('❌ Erro ao processar confirmação de análise:', error);
      await this.sendMessage(phone, '❌ Erro ao processar sua resposta. Tente novamente.');
    }
  }

  /**
   * Avisa sobre aceitação apenas de PDF/DOCX durante análise
   */
  private async handleTextDuringAnalysis(phone: string, jurisdiction: string): Promise<void> {
    await this.sendMessage(phone, this.getTextDuringAnalysisMessage(jurisdiction));
  }

  /**
   * Verifica se a mensagem é uma confirmação (sim/não) usando IA
   */
  private async isConfirmationMessage(message: any, jurisdiction: string): Promise<boolean> {
    try {
      const text = message.message?.conversation || '';
      
      // Usar IA para detectar confirmação/negação
      const detection = await this.aiService.detectConfirmationOrDenial(text, jurisdiction);
      
      // Retorna true se for confirmação ou negação com confiança alta
      return (detection.isConfirmation || detection.isDenial) && detection.confidence > 0.7;
    } catch (error) {
      this.logger.error('❌ Erro ao verificar confirmação com IA:', error);
      
      // Fallback para verificação simples
      const text = message.message?.conversation?.toLowerCase() || '';
      return text.includes('sim') || text.includes('yes') || text.includes('s') ||
             text.includes('não') || text.includes('nao') || text.includes('no') || text.includes('n') ||
             text.includes('sí') || text.includes('si');
    }
  }

  /**
   * Mensagens de timeout de análise por jurisdição
   */
  private getAnalysisTimeoutMessage(jurisdiction: string): string {
    switch (jurisdiction) {
      case 'BR':
        return '⏰ Acho que não deseja enviar documento. Estou saindo do modo de espera.';
      case 'PT':
        return '⏰ Parece que não deseja enviar documento. Estou a sair do modo de espera.';
      case 'ES':
        return '⏰ Parece que no desea enviar documento. Estoy saliendo del modo de espera.';
      default:
        return '⏰ Timeout reached. Exiting analysis mode.';
    }
  }

  /**
   * Mensagens de confirmação de análise por jurisdição
   */
  private getAnalysisConfirmationMessage(jurisdiction: string): string {
    switch (jurisdiction) {
      case 'BR':
        return '✅ Ok, pode enviar outro documento para ser analisado.';
      case 'PT':
        return '✅ Ok, pode enviar outro documento para ser analisado.';
      case 'ES':
        return '✅ Ok, puede enviar otro documento para ser analizado.';
      default:
        return '✅ Ok, you can send another document to be analyzed.';
    }
  }

  /**
   * Mensagens de aviso sobre PDF/DOCX por jurisdição
   */
  private getTextDuringAnalysisMessage(jurisdiction: string): string {
    switch (jurisdiction) {
      case 'BR':
        return '⚠️ Durante a análise de documentos, só aceito arquivos PDF ou DOCX. Envie um documento válido ou responda "sim" ou "não" para continuar.';
      case 'PT':
        return '⚠️ Durante a análise de documentos, só aceito ficheiros PDF ou DOCX. Envie um documento válido ou responda "sim" ou "não" para continuar.';
      case 'ES':
        return '⚠️ Durante el análisis de documentos, solo acepto archivos PDF o DOCX. Envíe un documento válido o responda "sí" o "no" para continuar.';
      default:
        return '⚠️ During document analysis, I only accept PDF or DOCX files. Send a valid document or answer "yes" or "no" to continue.';
    }
  }

  /**
   * Mensagens de resposta não reconhecida por jurisdição
   */
  private getUnrecognizedResponseMessage(jurisdiction: string): string {
    switch (jurisdiction) {
      case 'BR':
        return '❓ Por favor, responda "sim" ou "não" se deseja analisar outro documento.';
      case 'PT':
        return '❓ Por favor, responda "sim" ou "não" se deseja analisar outro documento.';
      case 'ES':
        return '❓ Por favor, responda "sí" o "no" si desea analizar otro documento.';
      default:
        return '❓ Please answer "yes" or "no" if you want to analyze another document.';
    }
  }

  /**
   * Gera prompt localizado para análise de documento baseado na jurisdição
   */
  private generateLocalizedAnalysisPrompt(jurisdiction?: string): string {
    const isSpanish = jurisdiction === 'ES';
    const isPortuguese = jurisdiction === 'PT';
    
    if (isSpanish) {
      return `Analiza este documento jurídico y proporciona un resumen completo y detallado.

IMPORTANTE: Devuelve la respuesta EXACTAMENTE en el formato JSON siguiente, sin texto adicional:

{
  "documentType": "tipo de documento (contrato, petición, dictamen, sentencia, etc.)",
  "parties": ["lista de las partes involucradas"],
  "mainObjective": "objetivo principal del documento",
  "importantPoints": ["lista de los puntos más relevantes"],
  "relevantClauses": ["cláusulas o artículos más importantes"],
  "deadlinesAndValues": "plazos, valores y fechas importantes",
  "identifiedRisks": ["riesgos o problemas identificados"],
  "recommendations": ["sugerencias prácticas"],
  "executiveSummary": "resumen conciso de los puntos principales"
}

Sé específico, práctico y proporciona un análisis jurídico completo y útil.`;
    }
    
    if (isPortuguese) {
      return `Analisa este documento jurídico e fornece um resumo completo e detalhado.

IMPORTANTE: Retorna a resposta EXATAMENTE no formato JSON abaixo, sem texto adicional:

{
  "documentType": "tipo do documento (contrato, petição, parecer, sentença, etc.)",
  "parties": ["lista das partes envolvidas"],
  "mainObjective": "objetivo principal do documento",
  "importantPoints": ["lista dos pontos mais relevantes"],
  "relevantClauses": ["cláusulas ou artigos mais importantes"],
  "deadlinesAndValues": "prazos, valores e datas importantes",
  "identifiedRisks": ["riscos ou problemas identificados"],
  "recommendations": ["sugestões práticas"],
  "executiveSummary": "resumo conciso dos pontos principais"
}

Seja específico, prático e forneça uma análise jurídica completa e útil.`;
    }
    
    // Default para Brasil (português brasileiro)
    return `Analise este documento jurídico e forneça um resumo completo e detalhado. 

IMPORTANTE: Retorne a resposta EXATAMENTE no formato JSON abaixo, sem texto adicional:

{
  "documentType": "tipo do documento (contrato, petição, parecer, sentença, etc.)",
  "parties": ["lista das partes envolvidas"],
  "mainObjective": "objetivo principal do documento",
  "importantPoints": ["lista dos pontos mais relevantes"],
  "relevantClauses": ["cláusulas ou artigos mais importantes"],
  "deadlinesAndValues": "prazos, valores e datas importantes",
  "identifiedRisks": ["riscos ou problemas identificados"],
  "recommendations": ["sugestões práticas"],
  "executiveSummary": "resumo conciso dos pontos principais"
}

Seja específico, prático e forneça uma análise jurídica completa e útil.`;
  }

  /**
   * Formata análise do documento em texto legível para o usuário (localizado)
   */
  private formatDocumentAnalysisForUser(analysisData: any, jurisdiction?: string): string {
    try {
      const isSpanish = jurisdiction === 'ES';
      const isPortuguese = jurisdiction === 'PT';
      
      let formattedText: string;
      let labels: any;
      
      if (isSpanish) {
        formattedText = '📄 **ANÁLISIS JURÍDICO DEL DOCUMENTO**\n\n';
        labels = {
          documentType: '📋 **Tipo de Documento:**',
          parties: '👥 **Partes Involucradas:**',
          mainObjective: '🎯 **Objetivo Principal:**',
          importantPoints: '⭐ **Puntos Importantes:**',
          relevantClauses: '📜 **Cláusulas/Artículos Relevantes:**',
          deadlinesAndValues: '⏰ **Plazos y Valores:**',
          identifiedRisks: '⚠️ **Riesgos Identificados:**',
          recommendations: '💡 **Recomendaciones:**',
          executiveSummary: '📝 **Resumen Ejecutivo:**',
          completed: '✅ *¡Análisis completado con éxito!*'
        };
      } else if (isPortuguese) {
        formattedText = '📄 **ANÁLISE JURÍDICA DO DOCUMENTO**\n\n';
        labels = {
          documentType: '📋 **Tipo de Documento:**',
          parties: '👥 **Partes Envolvidas:**',
          mainObjective: '🎯 **Objetivo Principal:**',
          importantPoints: '⭐ **Pontos Importantes:**',
          relevantClauses: '📜 **Cláusulas/Artigos Relevantes:**',
          deadlinesAndValues: '⏰ **Prazos e Valores:**',
          identifiedRisks: '⚠️ **Riscos Identificados:**',
          recommendations: '💡 **Recomendações:**',
          executiveSummary: '📝 **Resumo Executivo:**',
          completed: '✅ *Análise concluída com sucesso!*'
        };
      } else {
        // Default para Brasil
        formattedText = '📄 **ANÁLISE JURÍDICA DO DOCUMENTO**\n\n';
        labels = {
          documentType: '📋 **Tipo de Documento:**',
          parties: '👥 **Partes Envolvidas:**',
          mainObjective: '🎯 **Objetivo Principal:**',
          importantPoints: '⭐ **Pontos Importantes:**',
          relevantClauses: '📜 **Cláusulas/Artigos Relevantes:**',
          deadlinesAndValues: '⏰ **Prazos e Valores:**',
          identifiedRisks: '⚠️ **Riscos Identificados:**',
          recommendations: '💡 **Recomendações:**',
          executiveSummary: '📝 **Resumo Executivo:**',
          completed: '✅ *Análise concluída com sucesso!*'
        };
      }

      // Tipo de Documento
      if (analysisData.documentType) {
        formattedText += `${labels.documentType} ${analysisData.documentType}\n\n`;
      }

      // Partes Envolvidas
      if (analysisData.parties && Array.isArray(analysisData.parties) && analysisData.parties.length > 0) {
        formattedText += `${labels.parties}\n`;
        analysisData.parties.forEach((party: string, index: number) => {
          formattedText += `• ${party}\n`;
        });
        formattedText += '\n';
      }

      // Objetivo Principal
      if (analysisData.mainObjective) {
        formattedText += `${labels.mainObjective}\n${analysisData.mainObjective}\n\n`;
      }

      // Pontos Importantes
      if (analysisData.importantPoints && Array.isArray(analysisData.importantPoints) && analysisData.importantPoints.length > 0) {
        formattedText += `${labels.importantPoints}\n`;
        analysisData.importantPoints.forEach((point: string, index: number) => {
          formattedText += `• ${point}\n`;
        });
        formattedText += '\n';
      }

      // Cláusulas Relevantes
      if (analysisData.relevantClauses && Array.isArray(analysisData.relevantClauses) && analysisData.relevantClauses.length > 0) {
        formattedText += `${labels.relevantClauses}\n`;
        analysisData.relevantClauses.forEach((clause: string, index: number) => {
          formattedText += `• ${clause}\n`;
        });
        formattedText += '\n';
      }

      // Prazos e Valores
      if (analysisData.deadlinesAndValues) {
        formattedText += `${labels.deadlinesAndValues}\n${analysisData.deadlinesAndValues}\n\n`;
      }

      // Riscos Identificados
      if (analysisData.identifiedRisks && Array.isArray(analysisData.identifiedRisks) && analysisData.identifiedRisks.length > 0) {
        formattedText += `${labels.identifiedRisks}\n`;
        analysisData.identifiedRisks.forEach((risk: string, index: number) => {
          formattedText += `• ${risk}\n`;
        });
        formattedText += '\n';
      }

      // Recomendações
      if (analysisData.recommendations && Array.isArray(analysisData.recommendations) && analysisData.recommendations.length > 0) {
        formattedText += `${labels.recommendations}\n`;
        analysisData.recommendations.forEach((recommendation: string, index: number) => {
          formattedText += `• ${recommendation}\n`;
        });
        formattedText += '\n';
      }

      // Resumo Executivo
      if (analysisData.executiveSummary) {
        formattedText += `${labels.executiveSummary}\n${analysisData.executiveSummary}\n\n`;
      }

      formattedText += '---\n';
      formattedText += labels.completed;

      return formattedText;
    } catch (error) {
      this.logger.error('❌ Erro ao formatar análise:', error);
      return '❌ Erro ao processar a análise do documento.';
    }
  }

  /**
   * Obtém mensagem localizada baseada na jurisdição
   */
  private getLocalizedMessage(key: string, jurisdiction?: string): string {
    const isSpanish = jurisdiction === 'ES';
    const isPortuguese = jurisdiction === 'PT';
    
    const messages = {
      analyzing_document: {
        ES: '🔍 Estoy analizando el documento jurídico...',
        PT: '🔍 Estou a analisar o documento jurídico...',
        BR: '🔍 Estou analisando o documento jurídico...'
      },
      analyze_another_document: {
        ES: '\n\n🤔 ¿Deseas analizar otro documento? Responde "sí" o "no".',
        PT: '\n\n🤔 Desejas analisar outro documento? Responde "sim" ou "não".',
        BR: '\n\n🤔 Deseja analisar outro documento? Responda "sim" ou "não".'
      }
    };
    
    if (isSpanish) return messages[key]?.ES || messages[key]?.BR;
    if (isPortuguese) return messages[key]?.PT || messages[key]?.BR;
    return messages[key]?.BR || messages[key]?.ES;
  }

  /**
   * Obtém mensagem de erro localizada baseada na jurisdição
   */
  private getLocalizedErrorMessage(key: string, jurisdiction?: string): string {
    const isSpanish = jurisdiction === 'ES';
    const isPortuguese = jurisdiction === 'PT';
    
    const errorMessages = {
      extract_document_failed: {
        ES: '❌ No pude extraer el documento del mensaje. Inténtalo de nuevo.',
        PT: '❌ Não consegui extrair o documento da mensagem. Tenta novamente.',
        BR: '❌ Não consegui extrair o documento da mensagem. Tente novamente.'
      },
      file_too_large: {
        ES: '❌ Archivo muy grande. El límite es de 20MB. Envía un archivo más pequeño.',
        PT: '❌ Ficheiro muito grande. O limite é de 20MB. Envia um ficheiro mais pequeno.',
        BR: '❌ Arquivo muito grande. O limite é de 20MB. Envie um arquivo menor.'
      },
      unsupported_file_type: {
        ES: '❌ Tipo de documento no soportado. Envía solo PDF o DOCX.',
        PT: '❌ Tipo de documento não suportado. Envia apenas PDF ou DOCX.',
        BR: '❌ Tipo de documento não suportado. Envie apenas PDF ou DOCX.'
      },
      document_analysis_failed: {
        ES: '❌ Error al analizar el documento. Envía el documento de nuevo.',
        PT: '❌ Erro ao analisar o documento. Envia o documento novamente.',
        BR: '❌ Erro ao analisar o documento. Envie o documento novamente.'
      }
    };
    
    if (isSpanish) return errorMessages[key]?.ES || errorMessages[key]?.BR;
    if (isPortuguese) return errorMessages[key]?.PT || errorMessages[key]?.BR;
    return errorMessages[key]?.BR || errorMessages[key]?.ES;
  }
} 
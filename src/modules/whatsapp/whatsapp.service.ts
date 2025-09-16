import { Injectable, Logger } from '@nestjs/common';
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

interface ConversationState {
  isWaitingForName: boolean;
  isWaitingForEmail: boolean;
  isWaitingForConfirmation: boolean;
  isWaitingForBrazilianName: boolean;
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
}

interface LegalDocument {
  id: string;
  user_id: string;
  type: string;
  content: string;
  analysis?: string;
  jurisdiction: string;
  created_at: string;
}

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private conversationStates = new Map<string, ConversationState>();

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
  ) {}

  // Métodos auxiliares para buscar planos dinamicamente
  private async getAllActivePlans() {
    try {
      return await this.plansService.getAllPlans();
    } catch (error) {
      this.logger.error('Erro ao buscar planos ativos:', error);
      throw error;
    }
  }

  private async getUpgradePlans() {
    try {
      return await this.plansService.getUpgradePlans();
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

  private async getPlanLimits(planName: string, jurisdiction: string): Promise<string> {
    try {
      const plan = await this.plansService.getPlanByName(planName);
      
      if (plan.is_unlimited) {
        return '• Consultas jurídicas ilimitadas\n• Análise de documentos ilimitada\n• Mensagens ilimitadas';
      } else {
        const limitControlType = this.jurisdictionService.getLimitControlType(jurisdiction);
        
        if (limitControlType === 'teams') {
          // Para Brasil - limites controlados via Supabase teams
          return `• Consultas jurídicas controladas via sistema\n• Análise de documentos controlada via sistema\n• Mensagens controladas via sistema`;
        } else {
          // Para Portugal/Espanha - limites locais
          return `• ${plan.consultation_limit} consultas por mês\n• Análise de documentos incluída\n• Mensagens ilimitadas`;
        }
      }
    } catch (error) {
      this.logger.error(`Erro ao buscar limites do plano ${planName}:`, error);
      throw error;
    }
  }

  private async detectPlanFromMessage(userMessage: string): Promise<string | null> {
    try {
      this.logger.log('📋 Detectando plano da mensagem com IA:', userMessage);
      
      // Usar IA para detectar plano
      const planAnalysis = await this.aiService.detectPlanFromMessage(userMessage);
      
      if (planAnalysis.planName && planAnalysis.confidence > 0.6) {
        this.logger.log('🤖 Plano detectado pela IA:', planAnalysis);
        return planAnalysis.planName;
      }
      
      // Fallback para detecção manual
      const plans = await this.getUpgradePlans();
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
        await this.sendMessage(phone, response);
        return;
      }
      
      // Para PT/ES, fluxo de cadastro via WhatsApp
      if (!state.isInRegistrationFlow) {
        // Iniciar fluxo de cadastro
        const response = `🌍 Olá! Seja bem-vindo ao Chat LawX!\n\nSou seu assistente jurídico e estou aqui para ajudá-lo com consultas legais.\n\nPara começar, preciso de algumas informações:\n\n📝 Qual é o seu nome completo?`;
        await this.sendMessage(phone, response);
        this.setConversationState(phone, {
          isInRegistrationFlow: true,
          registrationStep: 'name',
          isWaitingForName: true,
          isWaitingForEmail: false,
          isWaitingForConfirmation: false,
          isInUpgradeFlow: false,
          upgradeStep: 'introduction',
          jurisdiction: jurisdiction.jurisdiction,
          ddi: jurisdiction.ddi
        });
        return;
      }

      // Processar etapas do cadastro
      if (state.registrationStep === 'name' && state.isWaitingForName) {
        // Validar nome
        if (text.length < 2) {
          await this.sendMessage(phone, '❌ Por favor, informe um nome válido com pelo menos 2 caracteres.');
        return;
      }

        // Solicitar email
        const response = `✅ Obrigado, ${text}!\n\n📧 Agora preciso do seu e-mail para completar o cadastro:`;
        await this.sendMessage(phone, response);
        this.setConversationState(phone, {
          ...state,
          registrationStep: 'email',
          isWaitingForName: false,
          isWaitingForEmail: true,
          pendingName: text
        });
        return;
      }

      if (state.registrationStep === 'email' && state.isWaitingForEmail) {
        // Validar email
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(text)) {
          await this.sendMessage(phone, '❌ Por favor, informe um e-mail válido.');
          return;
        }

        // Confirmar dados
        const response = `✅ Perfeito!\n\n📋 Confirme seus dados:\n\n👤 Nome: ${state.pendingName}\n📧 E-mail: ${text}\n📱 Telefone: ${phone}\n🌍 País: ${jurisdiction.country}\n\nDigite "CONFIRMAR" para finalizar o cadastro ou "CANCELAR" para recomeçar.`;
        await this.sendMessage(phone, response);
        this.setConversationState(phone, {
          ...state,
          registrationStep: 'confirmation',
          isWaitingForEmail: false,
          isWaitingForConfirmation: true,
          pendingEmail: text
        });
        return;
      }

      if (state.registrationStep === 'confirmation' && state.isWaitingForConfirmation) {
        if (text.toUpperCase() === 'CONFIRMAR') {
          // Finalizar cadastro
          await this.finalizeUserRegistration(phone, state, jurisdiction);
        } else if (text.toUpperCase() === 'CANCELAR') {
          // Recomeçar cadastro
          const response = '🔄 Cadastro cancelado. Vamos recomeçar!\n\n📝 Qual é o seu nome completo?';
          await this.sendMessage(phone, response);
          this.setConversationState(phone, { 
            isInRegistrationFlow: true,
            registrationStep: 'name',
            isWaitingForName: true, 
            isWaitingForEmail: false,
            isWaitingForConfirmation: false,
            isInUpgradeFlow: false,
            upgradeStep: 'introduction',
            jurisdiction: jurisdiction.jurisdiction,
            ddi: jurisdiction.ddi
          });
        } else {
          await this.sendMessage(phone, '❌ Por favor, digite "CONFIRMAR" para finalizar ou "CANCELAR" para recomeçar.');
        }
        return;
      }

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
      
      await this.sendMessage(phone, response);
      
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
      // Remove o DDI (55) e caracteres não numéricos
      const cleanPhone = phone.replace(/\D/g, '');
      const phoneWithoutDDI = cleanPhone.startsWith('55') ? cleanPhone.substring(2) : cleanPhone;
      
      this.logger.log(`🔍 Verificando sessão brasileira para: ${phoneWithoutDDI}`);
      
      // Buscar na tabela atendimento_wpps
      const { data, error } = await this.supabaseService
        .getClient()
        .from('atendimento_wpps')
        .select('*')
        .eq('number', phoneWithoutDDI)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          this.logger.log(`👤 Sessão não encontrada para: ${phoneWithoutDDI}`);
          return {
            session: null,
            needsWelcomeBack: false,
            timeSinceLastMessage: 0
          };
        }
        throw error;
      }

      this.logger.log(`✅ Sessão encontrada: ${data.id} - ${data.name}`);
      
      // Verificar se precisa de mensagem de boas-vindas (mais de 1 hora)
      const ONE_HOUR_MS = 60 * 60 * 1000; // 1 hora em milissegundos
      const lastMessageTime = data.last_message_sent ? new Date(data.last_message_sent).getTime() : 0;
      const currentTime = Date.now();
      const timeSinceLastMessage = currentTime - lastMessageTime;
      const needsWelcomeBack = timeSinceLastMessage > ONE_HOUR_MS;
      
      if (needsWelcomeBack) {
        this.logger.log(`⏰ Usuário ${data.name} precisa de mensagem de boas-vindas (última mensagem há ${Math.round(timeSinceLastMessage / (60 * 1000))} minutos)`);
      }
      
      return {
        session: data,
        needsWelcomeBack,
        timeSinceLastMessage
      };
    } catch (error) {
      this.logger.error(`❌ Erro ao verificar sessão brasileira ${phone}:`, error);
      return {
        session: null,
        needsWelcomeBack: false,
        timeSinceLastMessage: 0
      };
    }
  }

  private async handleWelcomeBackMessage(phone: string, session: any): Promise<void> {
    try {
      const message = `Bem vindo novamente ${session.name}, em que posso te ajudar?`;
      await this.sendMessage(phone, message);
      
      // Atualizar last_message_sent
      await this.updateLastMessageSent(phone);
      
      this.logger.log(`👋 Mensagem de boas-vindas enviada para ${session.name}`);
    } catch (error) {
      this.logger.error(`❌ Erro ao enviar mensagem de boas-vindas para ${phone}:`, error);
    }
  }

  private async updateLastMessageSent(phone: string): Promise<void> {
    try {
      // Remove o DDI (55) e caracteres não numéricos
      const cleanPhone = phone.replace(/\D/g, '');
      const phoneWithoutDDI = cleanPhone.startsWith('55') ? cleanPhone.substring(2) : cleanPhone;
      
      // Atualizar campo last_message_sent na tabela atendimento_wpps
      const { error } = await this.supabaseService
        .getClient()
        .from('atendimento_wpps')
        .update({ last_message_sent: new Date().toISOString() })
        .eq('number', phoneWithoutDDI);

      if (error) {
        throw error;
      }

      this.logger.log(`✅ Campo last_message_sent atualizado para ${phoneWithoutDDI}`);
    } catch (error) {
      this.logger.error(`❌ Erro ao atualizar last_message_sent para ${phone}:`, error);
    }
  }

  private async createBrazilianUserSession(phone: string, name: string): Promise<any> {
    try {
      // Remove o DDI (55) e caracteres não numéricos
      const cleanPhone = phone.replace(/\D/g, '');
      const phoneWithoutDDI = cleanPhone.startsWith('55') ? cleanPhone.substring(2) : cleanPhone;
      
      this.logger.log(`📝 Criando sessão brasileira: ${name} - ${phoneWithoutDDI}`);
      
      // Inserir na tabela atendimento_wpps
      const { data, error } = await this.supabaseService
        .getClient()
        .from('atendimento_wpps')
        .insert({
          name: name,
          number: phoneWithoutDDI
        })
        .select()
        .single();

      if (error) {
        throw error;
      }

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
          await this.sendMessage(phone, '❌ Por favor, informe um nome válido com pelo menos 2 caracteres.');
          return;
        }

        // Criar sessão na tabela atendimento_wpps
        await this.createBrazilianUserSession(phone, text);
        
        // Mensagem de boas-vindas
        const response = `🎉 Olá, ${text}! Seja bem-vindo ao Chat LawX!\n\n🇧🇷 Sou seu assistente jurídico especializado em legislação brasileira.\n\n💬 Como posso ajudá-lo hoje?\n\nVocê pode:\n• Fazer perguntas sobre direito\n• Enviar documentos para análise\n• Solicitar orientações jurídicas\n\nDigite "MENU" para ver todas as opções disponíveis.`;
        
        await this.sendMessage(phone, response);
        
        // Limpar estado da conversa
        this.clearConversationState(phone);
        
        this.logger.log(`✅ Usuário brasileiro ${phone} iniciou sessão com nome: ${text}`);
        return;
      }

      // Primeira mensagem - enviar boas-vindas e solicitar nome
      const response = `🇧🇷 Olá! Seja bem-vindo ao Chat LawX!\n\nSou seu assistente jurídico especializado em legislação brasileira.\n\nPara personalizar seu atendimento, preciso saber seu nome.\n\n📝 Qual é o seu nome completo?`;
      
      await this.sendMessage(phone, response);
      
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
      const jurisdiction = this.jurisdictionService.detectJurisdiction(phone);
      this.logger.log(`Jurisdição detectada: ${jurisdiction.jurisdiction} para ${phone}`);

      // Extrair texto da mensagem
      const text = message.message?.conversation || '';
      const state = this.getConversationState(phone);
      this.logger.log('💬 Estado da conversa:', JSON.stringify(state, null, 2));

      // Roteamento por jurisdição
      switch (jurisdiction.jurisdiction) {
        case 'BR':
          await this.processBrazilianMessage(message, phone, text, state, jurisdiction);
          break;
        case 'PT':
          await this.processPortugueseMessage(message, phone, text, state, jurisdiction);
          break;
        case 'ES':
          await this.processSpanishMessage(message, phone, text, state, jurisdiction);
          break;
        default:
          this.logger.warn(`Jurisdição não suportada: ${jurisdiction.jurisdiction}`);
          await this.sendMessage(phone, 'Desculpe, sua jurisdição não é suportada no momento.');
      }
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
          await this.sendMessage(phone, this.getAnalysisTimeoutMessage('BR'));
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
        await this.handleDocumentMessage(message, user, phone);
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
      // Buscar ou criar usuário local
      const user = await this.usersService.getOrCreateUser(phone);
      
      // Verificar se usuário não está registrado
      if (!user || !user.is_registered) {
        await this.handleUnregisteredUser(phone, text, state, jurisdiction, false);
        return;
      }

      // PRIMEIRO: Verificar se está em análise de documento
      if (state.isInAnalysis) {
        // Verificar timeout (10 minutos)
        if (this.checkAnalysisTimeout(state)) {
          await this.sendMessage(phone, this.getAnalysisTimeoutMessage('PT'));
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
        await this.handleAudioMessage(message, user, phone);
        return;
      }

      if (message.message?.documentMessage) {
        this.logger.log('📄 Processando documento jurídico (PT)');
        await this.handleDocumentMessage(message, user, phone);
        return;
      }

      // Processar texto
      this.logger.log('📝 Processando texto jurídico (PT)');
      await this.handleTextMessage(text, user, phone, state);

    } catch (error) {
      this.logger.error('Erro ao processar mensagem portuguesa:', error);
      await this.sendMessage(phone, '❌ Ocorreu um erro ao processar sua mensagem. Tente novamente.');
    }
  }

  private async processSpanishMessage(message: any, phone: string, text: string, state: ConversationState, jurisdiction: any): Promise<void> {
    try {
      this.logger.log('🇪🇸 Processando mensagem de usuário espanhol...');

      // Buscar ou criar usuário local
      const user = await this.usersService.getOrCreateUser(phone);
      
      // Verificar se usuário não está registrado
      if (!user || !user.is_registered) {
        await this.handleUnregisteredUser(phone, text, state, jurisdiction, false);
        return;
      }

      // PRIMEIRO: Verificar se está em análise de documento
      if (state.isInAnalysis) {
        // Verificar timeout (10 minutos)
        if (this.checkAnalysisTimeout(state)) {
          await this.sendMessage(phone, this.getAnalysisTimeoutMessage('ES'));
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
        await this.handleAudioMessage(message, user, phone);
        return;
      }

      if (message.message?.documentMessage) {
        this.logger.log('📄 Processando documento jurídico (ES)');
        await this.handleDocumentMessage(message, user, phone);
        return;
      }

      // Processar texto
      this.logger.log('📝 Processando texto jurídico (ES)');
      await this.handleTextMessage(text, user, phone, state);

    } catch (error) {
      this.logger.error('Erro ao processar mensagem espanhola:', error);
      await this.sendMessage(phone, '❌ Ocorreu un error al procesar tu mensaje. Inténtalo de nuevo.');
    }
  }

  private async handleImageMessage(message: any, user: User | null, phone: string): Promise<void> {
    try {
      this.logger.log('📸 Processando mensagem de imagem jurídica...');
      
      // Download da imagem
      const imageBuffer = await this.downloadImage(message);
      if (!imageBuffer) {
        await this.sendMessage(phone, '❌ Não consegui baixar a imagem. Tente novamente.');
        return;
      }

      await this.sendMessage(phone, '🔍 Estou analisando o documento jurídico...');
      
      // Detectar jurisdição
      const jurisdiction = this.jurisdictionService.detectJurisdiction(phone);
      
      // Analisar documento jurídico
      const analysis = await this.aiService.analyzeLegalDocument(
        imageBuffer,
        jurisdiction.jurisdiction,
        user?.id
      );
      
      // Salvar documento no banco de dados apropriado
      await this.saveLegalDocument(analysis, jurisdiction.jurisdiction, user?.id);
      
      // Enviar resposta com análise
      const response = `📋 **Análise do Documento Jurídico**\n\n` +
        `**Tipo:** ${analysis.type}\n\n` +
        `**Análise:**\n${analysis.analysis}\n\n` +
        `**Riscos Identificados:**\n${analysis.risks.map(risk => `• ${risk}`).join('\n')}\n\n` +
        `**Sugestões:**\n${analysis.suggestions.map(suggestion => `• ${suggestion}`).join('\n')}\n\n` +
        `⚠️ *Esta análise é informativa. Para casos específicos, consulte um advogado.*`;
      
      await this.sendMessage(phone, response);
      
    } catch (error) {
      this.logger.error('Erro ao processar imagem jurídica:', error);
      await this.sendMessage(phone, '❌ Erro ao analisar o documento. Tente novamente ou envie uma imagem mais clara.');
    }
  }

  private async handleTextMessage(text: string, user: User | null, phone: string, state: ConversationState): Promise<void> {
    try {
      this.logger.log('📝 Processando mensagem de texto jurídica:', text);

      // 0. Verificar se é comando "menu"
      if (text.toLowerCase().trim() === 'menu') {
        await this.showLegalMenu(phone);
        return;
      }

      // 1. Verificar se há sessão de upgrade ativa ou estado de upgrade
      if (user) {
        const activeSession = await this.upgradeSessionsService.getActiveSession(user.id);
        if (activeSession || state.isInUpgradeFlow) {
          this.logger.log('🔄 Sessão de upgrade ativa, processando com IA...');
          await this.processUpgradeFlowWithAI(phone, user.id, text, activeSession, state);
          return;
        }

        // 2. Verificar se é uma nova intenção de upgrade
        const upgradeIntent = await this.detectUpgradeIntent(text, user.id);
        if (upgradeIntent.isUpgradeIntent) {
          this.logger.log('🆕 Nova intenção de upgrade detectada:', upgradeIntent);
          await this.handleUpgradeFlow(phone, user.id, text);
          return;
        }
      }

      // 3. Processar consulta jurídica
      await this.handleLegalConsultation(text, phone, user);

    } catch (error) {
      this.logger.error('❌ Erro ao processar mensagem de texto:', error);
      await this.sendMessage(phone, '❌ Erro ao processar sua mensagem. Tente novamente.');
    }
  }
  
  private async handleAudioMessage(message: any, user: User, phone: string): Promise<void> {
    try {
      this.logger.log('🎵 Processando mensagem de áudio...');

      this.logger.log('🎵 Mensagem de áudio tipo:', JSON.stringify(message.message?.base64, null, 2));
      // Enviar mensagem de processamento
      await this.sendMessage(phone, '🎵 Processando seu áudio... Aguarde um momento.');
      
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

      // Upload do áudio para Supabase Storage
      const audioUrl = await this.uploadService.uploadAudioFile(audioBuffer, 'audio.mp3');
      
      // Processar áudio para consulta jurídica
      const transcribedText = await this.aiService.processAudioForLegalConsultation(audioBuffer);
      
      // Detectar jurisdição
      const jurisdiction = this.jurisdictionService.detectJurisdiction(phone);
      
      // Gerar resposta jurídica
      const response = await this.aiService.generateLegalResponse(
        transcribedText,
        phone,
        user?.id,
        undefined // Sem conteúdo de documento
      );
      
      await this.sendMessage(phone, response);
      
    } catch (error) {
      this.logger.error('❌ Erro ao processar áudio:', error);
      
      // Verificar se é erro de limite atingido (PRIORIDADE MÁXIMA)
      if (error.message && error.message.includes('Limite de mensagens atingido')) {
        await this.handleLimitReachedMessage(phone, user, error.message);
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

  private async handleDocumentMessage(message: any, user: User | null, phone: string): Promise<void> {
    try {
      this.logger.log('📄 Processando mensagem de documento jurídico...');
      
      // Definir estado de análise
      const conversationState = this.getConversationState(phone);
      this.setConversationState(phone, {
        ...conversationState,
        isInAnalysis: true,
        analysisStartTime: Date.now()
      });
      
      // Extrair base64 da mensagem
      const base64Data = this.extractBase64FromDocumentMessage(message);
      if (!base64Data) {
        await this.sendMessage(phone, '❌ Não consegui extrair o documento da mensagem. Tente novamente.');
        return;
      }

      // Converter base64 para buffer
      const documentBuffer = await this.convertBase64ToFile(base64Data, 'unknown');

      // Verificar tamanho do arquivo (limite 20MB)
      const fileSizeMB = documentBuffer.length / (1024 * 1024);
      if (fileSizeMB > 20) {
        await this.sendMessage(phone, '❌ Arquivo muito grande. O limite é de 20MB. Envie um arquivo menor.');
        return;
      }

      // Detectar tipo de documento
      const mimeType = this.detectDocumentType(documentBuffer);
      if (!this.isSupportedDocumentType(mimeType)) {
        await this.sendMessage(phone, '❌ Tipo de documento não suportado. Envie apenas PDF ou DOCX.');
        return;
      }

      await this.sendMessage(phone, '🔍 Estou analisando o documento jurídico...');

      // Gerar nome do arquivo
      const fileName = this.generateDocumentFileName(mimeType);

      // Upload para Supabase Storage
      const fileUrl = await this.uploadService.uploadDocumentFile(documentBuffer, fileName);

      // Enviar para endpoint de análise
      const analysis = await this.analyzeDocumentWithExternalAPI(fileUrl);

      // Enviar resposta para usuário
      await this.sendMessage(phone, analysis);
      
      // Perguntar se deseja analisar outro documento
      await this.sendMessage(phone, '\n\n🤔 Deseja analisar outro documento? Responda "sim" ou "não".');

    } catch (error) {
      this.logger.error('❌ Erro ao processar documento:', error);
      
      // Verificar se é erro de limite atingido (PRIORIDADE MÁXIMA)
      if (error.message && error.message.includes('Limite de mensagens atingido')) {
        await this.handleLimitReachedMessage(phone, user, error.message);
        return;
      }
      
      // Manter estado de análise e solicitar reenvio
      await this.sendMessage(phone, '❌ Erro ao analisar o documento. Envie o documento novamente.');
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

  private async handleLegalConsultation(text: string, phone: string, user: User | null): Promise<void> {
    try {
      // Detectar jurisdição
      const jurisdiction = this.jurisdictionService.detectJurisdiction(phone);
      
      // Gerar resposta jurídica
      const response = await this.aiService.generateLegalResponse(
        text,
        phone,
        user?.id,
        undefined // Sem conteúdo de documento
      );
      
      await this.sendMessage(phone, response);
      
    } catch (error) {
      this.logger.error('Erro ao processar consulta jurídica:', error);
      
      // Verificar se é erro de limite atingido
      if (error.message && error.message.includes('Limite de mensagens atingido')) {
        await this.handleLimitReachedMessage(phone, user, error.message);
      } else {
        await this.sendMessage(phone, '❌ Erro ao processar sua consulta jurídica. Tente novamente.');
      }
    }
  }

  private async handleLimitReachedMessage(phone: string, user: User | null, errorMessage: string): Promise<void> {
    try {
      // Detectar jurisdição para personalizar mensagem
      const jurisdiction = this.jurisdictionService.detectJurisdiction(phone);
      
      if (jurisdiction.jurisdiction === 'BR') {
        // Mensagem específica para usuários brasileiros
        const response = `🚫 **Limite de mensagens atingido!**\n\n` +
          `Você utilizou todas as suas mensagens disponíveis.\n\n` +
          `💡 **Opções disponíveis:**\n` +
          `• Entre em contato com seu administrador para aumentar o limite\n` +
          `• Aguarde o próximo período de renovação\n\n` +
          `📞 **Suporte:** Entre em contato conosco para mais informações.`;
        
        await this.sendMessage(phone, response);
      } else {
        // Mensagem para PT/ES com opção de upgrade
        const response = `🚫 **Limite de mensagens atingido!**\n\n` +
          `Você utilizou todas as suas mensagens disponíveis.\n\n` +
          `💡 **Que tal fazer um upgrade?**\n` +
          `• Acesse planos premium com mensagens ilimitadas\n` +
          `• Recursos avançados de análise jurídica\n` +
          `• Suporte prioritário\n\n` +
          `🔄 Digite "UPGRADE" para ver os planos disponíveis ou "MENU" para outras opções.`;
        
        await this.sendMessage(phone, response);
      }
      
    } catch (error) {
      this.logger.error('Erro ao processar mensagem de limite:', error);
      await this.sendMessage(phone, '❌ Limite atingido. Entre em contato para mais informações.');
    }
  }

  /**
   * Mostra menu jurídico
   */
  private async showLegalMenu(phone: string): Promise<void> {
    const menu = `⚖️ **Chat LawX - Menu Jurídico**\n\n` +
      `📋 **Funcionalidades Disponíveis:**\n` +
      `• Envie documentos jurídicos (contratos, petições, etc.)\n` +
      `• Faça consultas jurídicas por texto\n` +
      `• Análise de riscos em documentos\n` +
      `• Sugestões de cláusulas contratuais\n` +
      // `• Pesquisa de jurisprudência\n\n` +
      `💡 **Como usar:**\n` +
      `• Digite sua pergunta jurídica\n` +
      `• Envie foto de documento para análise\n` +
      // `• Use "upgrade" para ver planos premium\n\n` +
      `⚠️ *Lembre-se: Este é um assistente informativo. Para casos específicos, consulte um advogado.*`;
    
    await this.sendMessage(phone, menu);
  }

  private async detectUpgradeIntent(text: string, userId: string): Promise<{
    isUpgradeIntent: boolean;
    confidence: number;
    intent: 'new_upgrade' | 'continue_upgrade' | 'payment_confirmation' | 'frequency_selection' | 'plan_selection' | 'cancel_upgrade';
    context?: any;
  }> {
    try {
      this.logger.log('🔄 Detectando intent de upgrade com IA:', text);
      
      // Verificar se há sessão ativa primeiro
      const activeSession = await this.upgradeSessionsService.getActiveSession(userId);
      const state = this.getConversationState(userId.replace('@s.whatsapp.net', ''));
      
      // Se há sessão ativa ou estado de upgrade, analisar no contexto
      if (activeSession || state.isInUpgradeFlow) {
        this.logger.log('🔄 Sessão ativa encontrada, analisando contexto...');
        return await this.analyzeUpgradeContext(text, activeSession, state);
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

  private async analyzeUpgradeContext(text: string, session: any, state: any): Promise<{
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
      return await this.fallbackUpgradeIntentDetection(text, session, state, 'BR'); // Default para BR
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
    try {
      const imageUrl = messageData.message?.imageMessage?.url;
      
      // Primeira tentativa: usar a API de mídia do WhatsApp (base64)
      try {
        return await this.downloadFromWhatsAppMedia(messageData);
      } catch (mediaError) {
        console.log('📥 Falha na API de mídia (base64), tentando fallback:', mediaError.message);
      }

      // Segunda tentativa: usar o mesmo endpoint como fallback
      try {
        return await this.downloadFromMessagesAPI(messageData);
      } catch (fallbackError) {
        console.log('📥 Falha no fallback (base64), tentando download direto:', fallbackError.message);
      }

      // Terceira tentativa: download direto com headers específicos (se tiver URL)
      if (!imageUrl) {
        throw new Error('URL da imagem não encontrada para download direto');
      }

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
      
      // Primeira tentativa: seguir redirecionamentos
      let response;
      try {
        response = await axios.get(imageUrl, { 
          responseType: 'arraybuffer',
          headers,
          timeout: 30000,
          maxRedirects: 10,
          validateStatus: (status) => status < 400,
        });
      } catch (redirectError) {
        // Segunda tentativa: sem seguir redirecionamentos
        response = await axios.get(imageUrl, { 
          responseType: 'arraybuffer',
          headers,
          timeout: 30000,
          maxRedirects: 0,
          validateStatus: (status) => status < 400,
        });
      }

      const buffer = Buffer.from(response.data);

      // Verificar se o buffer tem conteúdo
      if (buffer.length === 0) {
        throw new Error('Buffer vazio recebido');
      }

      // Verificar se é realmente uma imagem
      const contentType = response.headers['content-type'];
      if (!contentType || !contentType.startsWith('image/')) {
        console.warn('⚠️ Content-Type não é uma imagem:', contentType);
        
        // Tentar detectar formato pelos primeiros bytes
        const firstBytes = buffer.slice(0, 8);
        console.log('📥 Primeiros bytes:', firstBytes.toString('hex'));
        
        // Verificar se é um arquivo JPEG válido
        const isJPEG = firstBytes[0] === 0xFF && firstBytes[1] === 0xD8 && firstBytes[2] === 0xFF;
        const isPNG = firstBytes[0] === 0x89 && firstBytes[1] === 0x50 && firstBytes[2] === 0x4E && firstBytes[3] === 0x47;
        const isWEBP = firstBytes.slice(0, 4).toString() === 'RIFF' && firstBytes.slice(8, 12).toString() === 'WEBP';
        
        console.log('📥 É JPEG:', isJPEG);
        console.log('📥 É PNG:', isPNG);
        console.log('📥 É WEBP:', isWEBP);
        
        if (!isJPEG && !isPNG && !isWEBP) {
          console.warn('⚠️ Formato de imagem não reconhecido pelos primeiros bytes');
          
          // Tentar converter se parecer ser uma imagem corrompida
          if (buffer.length > 1000) { // Arquivo grande o suficiente para ser uma imagem
            console.log('📥 Tentando processar como imagem potencialmente corrompida...');
          }
        }
      }

      return buffer;
    } catch (error) {
      console.error('❌ Erro ao baixar imagem:', error);
      
      if (error.response) {
        console.error('❌ Status da resposta:', error.response.status);
        console.error('❌ Headers da resposta:', error.response.headers);
        console.error('❌ URL final:', error.response.request?.res?.responseUrl);
      }
      
      throw new Error(`Falha ao baixar imagem: ${error.message}`);
    }
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

  async sendMessage(phone: string, message: string): Promise<void> {
    try {
      const evolutionApiUrl = this.configService.get('EVOLUTION_API_URL');
      const instanceName = this.configService.get('EVOLUTION_INSTANCE_NAME');
      const apiKey = this.configService.get('EVOLUTION_API_KEY');

      console.log('📤 Enviando mensagem para:', phone);
      console.log('📤 URL da API:', `${evolutionApiUrl}/message/sendText/${instanceName}`);
      console.log('📤 Mensagem:', message);

      const response = await axios.post(
        `${evolutionApiUrl}/message/sendText/${instanceName}`,
        {
          number: phone,
          text: message,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'apikey': apiKey,
          },
        }
      );

      console.log('✅ Mensagem enviada com sucesso:', response.data);
      this.logger.log(`Mensagem enviada para ${phone}`);
    } catch (error) {
      console.error('❌ Erro ao enviar mensagem:', error);
      console.error('❌ Detalhes do erro:', error.response?.data);
      this.logger.error('Erro ao enviar mensagem:', error);
    }
  }

  async sendImage(phone: string, base64Image: string, caption?: string): Promise<void> {
    try {
      const evolutionApiUrl = this.configService.get('EVOLUTION_API_URL');
      const instanceName = this.configService.get('EVOLUTION_INSTANCE_NAME');
      const apiKey = this.configService.get('EVOLUTION_API_KEY');

      console.log('📤 Enviando imagem para:', phone);
      console.log('📤 URL da API:', `${evolutionApiUrl}/message/sendMedia/${instanceName}`);

      const response = await axios.post(
        `${evolutionApiUrl}/message/sendMedia/${instanceName}`,
        {
          number: phone,
          mediatype: 'image',
          mimetype: 'image/png',
          media: base64Image,
          caption: caption || '',
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'apikey': apiKey,
          },
        }
      );

      console.log('✅ Imagem enviada com sucesso:', response.data);
      this.logger.log(`Imagem enviada para ${phone}`);
    } catch (error) {
      console.error('❌ Erro ao enviar imagem:', error);
      console.error('❌ Detalhes do erro:', error.response?.data);
      this.logger.error('Erro ao enviar imagem:', error);
    }
  }

  private getConversationState(phone: string): ConversationState {
    const state = this.conversationStates.get(phone);
    return state || {
      isWaitingForName: false,
      isWaitingForEmail: false,
      isWaitingForConfirmation: false,
      isWaitingForBrazilianName: false,
      isInUpgradeFlow: false,
      isInRegistrationFlow: false,
      upgradeStep: 'introduction',
      registrationStep: 'introduction',
      isInAnalysis: false,
      analysisStartTime: undefined,
    };
  }

  private setConversationState(phone: string, state: Partial<ConversationState>): void {
    const currentState = this.conversationStates.get(phone) || {
      isWaitingForName: false,
      isWaitingForEmail: false,
      isWaitingForConfirmation: false,
      isWaitingForBrazilianName: false,
      isInUpgradeFlow: false,
      isInRegistrationFlow: false,
      registrationStep: 'introduction',
      upgradeStep: 'introduction',
      isInAnalysis: false,
      analysisStartTime: undefined
    };
    
    this.conversationStates.set(phone, { ...currentState, ...state });
  }

  private clearConversationState(phone: string): void {
    this.conversationStates.delete(phone);
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
    const usersInAnalysis: Array<{
      phone: string;
      jurisdiction: string;
      analysisStartTime: number;
    }> = [];

    for (const [phone, state] of this.conversationStates.entries()) {
      if (state.isInAnalysis && state.analysisStartTime) {
        // Detectar jurisdição baseada no número de telefone
        const detectionResult = this.jurisdictionService.detectJurisdiction(phone);
        
        usersInAnalysis.push({
          phone,
          jurisdiction: detectionResult.jurisdiction,
          analysisStartTime: state.analysisStartTime,
        });
      }
    }

    return usersInAnalysis;
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

  private async handleUpgradeFlow(phone: string, userId: string, userMessage: string): Promise<void> {
    try {
      console.log('🔄 Iniciando fluxo de upgrade com contexto...');
      
      // Verificar se há sessão ativa
      const activeSession = await this.upgradeSessionsService.getActiveSession(userId);
      
      if (activeSession) {
        this.logger.log('🔄 Sessão ativa encontrada, continuando...');
        await this.continueUpgradeFlowWithContext(phone, userId, userMessage, activeSession);
      } else {
        this.logger.log('🆕 Nova sessão de upgrade iniciada');
        await this.startNewUpgradeFlow(phone, userId, userMessage);
      }
    } catch (error) {
      this.logger.error('❌ Erro no fluxo de upgrade:', error);
      await this.sendMessage(phone, '❌ Erro no processo de upgrade. Tente novamente.');
    }
  }

  private async startNewUpgradeFlow(phone: string, userId: string, userMessage: string): Promise<void> {
    try {
      this.logger.log('🆕 Iniciando novo fluxo de upgrade...');
      
      // Verificar se a mensagem já especifica um plano
      const selectedPlanName = await this.detectPlanFromMessage(userMessage);
      
      if (selectedPlanName) {
        // Usuário já especificou o plano
        this.logger.log('📋 Plano especificado na mensagem, processando...');
        await this.processPlanSelection(phone, userId, userMessage);
      } else {
        // Perguntar sobre o plano
        this.logger.log('❓ Perguntando sobre plano...');
        const plans = await this.getUpgradePlans();
        
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
        
        // Criar sessão inicial (apenas para usuários não brasileiros)
        const user = await this.usersService.getOrCreateUser(phone);
        if (user) {
        await this.upgradeSessionsService.createSession({
          user_id: userId,
          phone: phone,
          plan_name: '',
          billing_cycle: 'monthly',
          amount: 0,
          current_step: 'plan_selection'
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
      const selectedPlanName = await this.detectPlanFromMessage(userMessage);
      
      if (!selectedPlanName) {
        const plans = await this.getUpgradePlans();
        const planNames = plans.map(p => p.name).join(' ou ');
        await this.sendMessage(phone, `❓ Qual plano você gostaria? ${planNames}?`);
        return;
      }
      
      // Buscar dados do plano selecionado
      const selectedPlan = await this.getPlanByName(selectedPlanName);
      
      // Perguntar sobre frequência de pagamento
      const discount = selectedPlan.yearly_price < (selectedPlan.monthly_price * 12) 
        ? ` (${Math.round(((selectedPlan.monthly_price * 12 - selectedPlan.yearly_price) / (selectedPlan.monthly_price * 12)) * 100)}% de desconto)`
        : '';
      
      const frequencyMessage = `✅ **Plano selecionado: ${selectedPlan.name}**

Agora escolha a frequência de pagamento:

🟢 **Mensal:** R$ ${selectedPlan.monthly_price.toFixed(2)}/mês
🟢 **Anual:** R$ ${selectedPlan.yearly_price.toFixed(2)}/ano${discount}

💡 **Recomendamos o plano anual** - Você economiza mais!`;

      await this.sendMessage(phone, frequencyMessage);
      await this.sendMessage(phone, 'Qual a frequência de pagamento ideal para você?');
      
      // Criar ou atualizar sessão com apenas o plano selecionado
      let session;
      if (existingSession) {
        session = await this.upgradeSessionsService.updateSession(existingSession.id, {
          plan_name: selectedPlan.name,
          current_step: 'plan_selection'
        });
      } else {
        const user = await this.usersService.getOrCreateUser(phone);
        if (user) {
        session = await this.upgradeSessionsService.createSession({
          user_id: userId,
          phone: phone,
          plan_name: selectedPlan.name,
          billing_cycle: 'monthly', // Temporário, será atualizado
          amount: 0, // Será calculado quando escolher frequência
          current_step: 'plan_selection'
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
      const user = await this.usersService.findByPhone(phone);
      if (!user) {
        await this.sendMessage(phone, '❌ Usuário não encontrado.');
        return;
      }

      const lowerMessage = userMessage.toLowerCase();
      let billingCycle: 'monthly' | 'yearly' = 'monthly';
      
      // Detectar frequência
      if (lowerMessage.includes('anual') || lowerMessage.includes('yearly') || lowerMessage.includes('ano')) {
        billingCycle = 'yearly';
      } else if (lowerMessage.includes('mensal') || lowerMessage.includes('monthly') || lowerMessage.includes('mês')) {
        billingCycle = 'monthly';
      } else {
        await this.sendMessage(phone, '❓ Escolha a frequência: "mensal" ou "anual"?');
        return;
      }
      
      // Buscar sessão ativa
      const session = await this.upgradeSessionsService.getActiveSession(userId);
      if (!session) {
        await this.sendMessage(phone, '❌ Sessão não encontrada. Digite "quero assinar" para começar novamente.');
        return;
      }
      
      // Buscar dados do plano para calcular preço
      const plan = await this.getPlanByName(session.plan_name);
      const planPrice = billingCycle === 'monthly' ? plan.monthly_price : plan.yearly_price;
      
      // Atualizar sessão com frequência e preço
      const updatedSession = await this.upgradeSessionsService.updateSession(session.id, {
        billing_cycle: billingCycle,
        amount: planPrice,
        current_step: 'payment_info'
      });
      
      // Buscar limites do plano
      const planLimits = await this.getPlanLimits(plan.name, user.jurisdiction);
      
      // Enviar confirmação
      const confirmationMessage = `✅ **Confirmação do Pedido:**

📋 **Plano:** ${plan.name}
💰 **Frequência:** ${billingCycle === 'monthly' ? 'Mensal' : 'Anual'}
💵 **Valor:** R$ ${planPrice.toFixed(2)}

🚀 **O que você terá:**
${planLimits}

💳 **Acima está todas as informações do seu plano**`;

      await this.sendMessage(phone, confirmationMessage);
      await this.sendMessage(phone, 'Posso gerar seu pagamento? Ah! no momento não temos suporte a cartão de crédito, mas aceitamos PIX.');
      
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
      const audioBuffer = await this.downloadFromEvolutionMediaAPI(message);
      
      if (!audioBuffer) {
        this.logger.error('❌ Falha ao baixar áudio via Evolution API');
        return null;
      }

      this.logger.log('✅ Áudio baixado com sucesso via Evolution API:', audioBuffer.length, 'bytes');
      
      // Verificar os primeiros bytes para debug
      const firstBytes = audioBuffer.slice(0, 16);
      this.logger.log('🔍 Primeiros bytes do arquivo:', firstBytes.toString('hex'));
      
      // Converter para MP3 para melhor compatibilidade
      try {
        const mp3Buffer = await this.uploadService.convertAudioToMp3(audioBuffer);
        this.logger.log('✅ Áudio convertido para MP3:', mp3Buffer.length, 'bytes');
        return mp3Buffer;
      } catch (conversionError) {
        this.logger.warn('⚠️ Falha na conversão para MP3, tentando conversão simples:', conversionError.message);
        try {
          const simpleBuffer = await this.uploadService.convertAudioSimple(audioBuffer);
          this.logger.log('✅ Conversão simples concluída:', simpleBuffer.length, 'bytes');
          return simpleBuffer;
        } catch (simpleError) {
          this.logger.warn('⚠️ Falha na conversão simples, usando buffer original:', simpleError.message);
          return audioBuffer;
        }
      }

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
          const mp3Buffer = await this.uploadService.convertAudioToMp3(buffer);
          this.logger.log('✅ Áudio convertido para MP3:', mp3Buffer.length, 'bytes');
          return mp3Buffer;
        } catch (conversionError) {
          this.logger.warn('⚠️ Falha na conversão para MP3, tentando conversão simples:', conversionError.message);
          try {
            const simpleBuffer = await this.uploadService.convertAudioSimple(buffer);
            this.logger.log('✅ Conversão simples concluída:', simpleBuffer.length, 'bytes');
            return simpleBuffer;
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
            const mp3Buffer = await this.uploadService.convertAudioToMp3(buffer);
            this.logger.log('✅ Áudio convertido para MP3:', mp3Buffer.length, 'bytes');
            return mp3Buffer;
          } catch (conversionError) {
            this.logger.warn('⚠️ Falha na conversão para MP3, tentando conversão simples:', conversionError.message);
            try {
              const simpleBuffer = await this.uploadService.convertAudioSimple(buffer);
              this.logger.log('✅ Conversão simples concluída:', simpleBuffer.length, 'bytes');
              return simpleBuffer;
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
      
      const audioMessage = messageData.message?.audioMessage;
      if (!audioMessage) {
        throw new Error('Mensagem de áudio não encontrada');
      }

      this.logger.log('🎵 Dados do áudio:', JSON.stringify(audioMessage, null, 2));

      // Método 1: Download via Evolution API Media Download (RECOMENDADO)
      if (audioMessage.url) {
        this.logger.log('🎵 Tentando download via Evolution API Media Download...');
        const audioBuffer = await this.downloadFromEvolutionMediaAPI(audioMessage);
        if (audioBuffer) {
          return audioBuffer;
        }
      }

      // Método 2: Download via URL direta (fallback)
      if (audioMessage.url) {
        this.logger.log('🎵 Tentando download direto da URL...');
        const audioBuffer = await this.downloadDirectFromUrl(audioMessage.url);
        if (audioBuffer) {
          return audioBuffer;
        }
      }

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
      switch (aiAnalysis.intent) {
        case 'payment_confirmation':
          await this.handlePaymentConfirmation(phone, userId, context);
          break;
          
        case 'frequency_selection':
          await this.handleFrequencySelectionWithAI(phone, userId, userMessage, context);
          break;
          
        case 'plan_selection':
          await this.handlePlanSelectionWithAI(phone, userId, userMessage, context);
          break;
          
        case 'cancel_upgrade':
          await this.handleCancelUpgrade(phone, userId, session);
          break;
          
        case 'continue_upgrade':
          await this.handleContinueUpgrade(phone, userId, userMessage, context);
          break;
          
        default:
          await this.handleContinueUpgrade(phone, userId, userMessage, context);
          break;
      }

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
        await this.sendMessage(phone, '❌ Informações do plano incompletas. Digite "quero assinar" para começar novamente.');
        return;
      }

      // Buscar dados do plano para calcular preço
      const plan = await this.getPlanByName(context.selectedPlan);
      const planPrice = context.selectedFrequency === 'monthly' ? plan.monthly_price : plan.yearly_price;
      
      const response = `🎉 **Excelente decisão! Vamos te ajudar na sua organização financeira!**

✅ **Resumo do Pedido:**
• Plano: ${context.selectedPlan}
• Frequência: ${context.selectedFrequency === 'monthly' ? 'Mensal' : 'Anual'}
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
          plan_name: context.selectedPlan,
          billing_cycle: context.selectedFrequency as 'monthly' | 'yearly',
          amount: planPrice,
          current_step: 'payment_processing'
        });
      } else {
        // Atualizar sessão existente
        session = await this.upgradeSessionsService.updateSession(session.id, {
          plan_name: context.selectedPlan,
          billing_cycle: context.selectedFrequency as 'monthly' | 'yearly',
          amount: planPrice,
          current_step: 'payment_processing'
        });
      }
      
      // Gerar PIX
      await this.generatePixPayment(phone, userId, context.selectedPlan, context.selectedFrequency, planPrice, session);
      
    } catch (error) {
      this.logger.error('❌ Erro ao processar confirmação de pagamento:', error);
      await this.sendMessage(phone, '❌ Erro ao processar pagamento. Tente novamente.');
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
        await this.processPlanSelection(phone, userId, userMessage);
      } else {
        const plans = await this.getUpgradePlans();
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

  private async analyzeDocumentWithExternalAPI(fileUrl: string): Promise<string> {
    try {
      this.logger.log('🔍 Enviando documento para análise externa...');
      
      const response = await axios.post(
        'https://us-central1-gleaming-nomad-443014-u2.cloudfunctions.net/vertex-LawX-personalizada',
        {
          prompt_text: `Analise este documento jurídico e forneça um resumo completo e detalhado. 

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

Seja específico, prático e forneça uma análise jurídica completa e útil.`,
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

      // Converter JSON para formato de texto legível
      return this.formatDocumentAnalysisForUser(analysisData);
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
        await this.showLegalMenu(phone);
        
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
   * Formata análise do documento em texto legível para o usuário
   */
  private formatDocumentAnalysisForUser(analysisData: any): string {
    try {
      let formattedText = '📄 **ANÁLISE JURÍDICA DO DOCUMENTO**\n\n';

      // Tipo de Documento
      if (analysisData.documentType) {
        formattedText += `📋 **Tipo de Documento:** ${analysisData.documentType}\n\n`;
      }

      // Partes Envolvidas
      if (analysisData.parties && Array.isArray(analysisData.parties) && analysisData.parties.length > 0) {
        formattedText += `👥 **Partes Envolvidas:**\n`;
        analysisData.parties.forEach((party: string, index: number) => {
          formattedText += `• ${party}\n`;
        });
        formattedText += '\n';
      }

      // Objetivo Principal
      if (analysisData.mainObjective) {
        formattedText += `🎯 **Objetivo Principal:**\n${analysisData.mainObjective}\n\n`;
      }

      // Pontos Importantes
      if (analysisData.importantPoints && Array.isArray(analysisData.importantPoints) && analysisData.importantPoints.length > 0) {
        formattedText += `⭐ **Pontos Importantes:**\n`;
        analysisData.importantPoints.forEach((point: string, index: number) => {
          formattedText += `• ${point}\n`;
        });
        formattedText += '\n';
      }

      // Cláusulas Relevantes
      if (analysisData.relevantClauses && Array.isArray(analysisData.relevantClauses) && analysisData.relevantClauses.length > 0) {
        formattedText += `📜 **Cláusulas/Artigos Relevantes:**\n`;
        analysisData.relevantClauses.forEach((clause: string, index: number) => {
          formattedText += `• ${clause}\n`;
        });
        formattedText += '\n';
      }

      // Prazos e Valores
      if (analysisData.deadlinesAndValues) {
        formattedText += `⏰ **Prazos e Valores:**\n${analysisData.deadlinesAndValues}\n\n`;
      }

      // Riscos Identificados
      if (analysisData.identifiedRisks && Array.isArray(analysisData.identifiedRisks) && analysisData.identifiedRisks.length > 0) {
        formattedText += `⚠️ **Riscos Identificados:**\n`;
        analysisData.identifiedRisks.forEach((risk: string, index: number) => {
          formattedText += `• ${risk}\n`;
        });
        formattedText += '\n';
      }

      // Recomendações
      if (analysisData.recommendations && Array.isArray(analysisData.recommendations) && analysisData.recommendations.length > 0) {
        formattedText += `💡 **Recomendações:**\n`;
        analysisData.recommendations.forEach((recommendation: string, index: number) => {
          formattedText += `• ${recommendation}\n`;
        });
        formattedText += '\n';
      }

      // Resumo Executivo
      if (analysisData.executiveSummary) {
        formattedText += `📝 **Resumo Executivo:**\n${analysisData.executiveSummary}\n\n`;
      }

      formattedText += '---\n';
      formattedText += '✅ *Análise concluída com sucesso!*';

      return formattedText;
    } catch (error) {
      this.logger.error('❌ Erro ao formatar análise:', error);
      return '❌ Erro ao processar a análise do documento.';
    }
  }
} 
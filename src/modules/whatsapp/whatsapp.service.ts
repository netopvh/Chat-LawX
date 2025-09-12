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
import { WebhookDto } from './dto/webhook.dto';

interface ConversationState {
  isWaitingForName: boolean;
  isWaitingForEmail: boolean;
  isWaitingForConfirmation: boolean;
  isInUpgradeFlow: boolean;
  isInRegistrationFlow: boolean;
  registrationStep: 'introduction' | 'name' | 'email' | 'confirmation' | 'completed';
  upgradeStep: 'introduction' | 'plan_selection' | 'frequency_selection' | 'payment_info' | 'confirmation';
  selectedPlan?: string;
  selectedFrequency?: 'monthly' | 'yearly';
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

  /**
   * Gerencia o fluxo de cadastro para usuários não registrados
   */
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
        const response = `🇧🇷 Olá! Seja bem-vindo ao Chat LawX!\n\nPara usuários brasileiros, você precisa se cadastrar em nossa plataforma web.\n\n🔗 Acesse: https://plataforma.lawx.ai/cadastro\n\nApós o cadastro, você poderá usar nosso assistente jurídico via WhatsApp.\n\nSe já possui cadastro, verifique se seu número está vinculado à sua conta.`;
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

  /**
   * Finaliza o cadastro do usuário e cria assinatura Fremium
   */
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

      // Verificar se é usuário brasileiro (já cadastrado no Supabase)
      const isBrazilianUser = jurisdiction.jurisdiction === 'BR';
      
      let user: User | null = null;
      if (!isBrazilianUser) {
        // Para Portugal/Espanha, criar ou buscar usuário local
        user = await this.usersService.getOrCreateUser(phone);
      }
      
      const state = this.getConversationState(phone);
      this.logger.log('💬 Estado da conversa:', JSON.stringify(state, null, 2));

      // Extrair texto da mensagem
      const text = message.message?.conversation || '';

      // Verificar se usuário não está registrado
      if (!user || !user.is_registered) {
        await this.handleUnregisteredUser(phone, text, state, jurisdiction, isBrazilianUser);
        return;
      }

      // Processar imagem se presente
      if (message.message?.imageMessage) {
        console.log('🖼️ Processando imagem');
        await this.handleImageMessage(message, user, phone);
        return;
      }

      // Processar áudio se presente
      if (message.message?.audioMessage) {
        console.log('🎵 Processando áudio');
        await this.handleAudioMessage(message, user, phone);
        return;
      }

      // Processar texto
      await this.handleTextMessage(text, user, phone, state);
    } catch (error) {
      this.logger.error('Erro ao processar mensagem:', error);
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

  /**
   * Salva documento jurídico no banco de dados apropriado
   */
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

  private async handleRevenueImage(extractedData: any, user: User, phone: string, imageBuffer: Buffer): Promise<void> {
    try {
      // Upload da imagem
      const imageUrl = await this.uploadService.uploadReceiptImage(imageBuffer, 'revenue.jpg');
      
      // Criar receita
      const revenueData = {
        user_id: user.id,
        amount: extractedData.amount,
        original_amount: extractedData.original_amount,
        discount_amount: extractedData.discount_amount,
        category: extractedData.category,
        date: extractedData.date,
        image_url: imageUrl,
        description: extractedData.description,
        payment_method: extractedData.payment_method,
        payer_name: extractedData.payer_name,
        payer_cnpj: extractedData.payer_cnpj,
        payer_address: extractedData.payer_address,
        document_type: extractedData.document_type,
        document_number: extractedData.document_number,
        revenue_type: extractedData.revenue_type,
        source: extractedData.source,
      };

      // TODO: Implementar criação de receita para Chat LawX
      // const revenue = await this.revenuesService.create(revenueData);
      
      // Incrementar contador de uso
      await this.usageService.incrementUsage(user.id, 'consultation');
      
      // Enviar confirmação
      // TODO: Implementar confirmação de receita para Chat LawX
      // const confirmationMessage = this.formatRevenueConfirmation(revenue);
      const confirmationMessage = '✅ Consulta jurídica registrada com sucesso!';
      await this.sendMessage(phone, confirmationMessage);
      
      this.logger.log(`✅ Receita criada com sucesso para usuário ${user.id}`);
      
    } catch (error) {
      this.logger.error('❌ Erro ao processar receita:', error);
      await this.sendMessage(phone, '❌ Erro ao processar a receita. Tente novamente.');
    }
  }

  private async handleExpenseImage(extractedData: any, user: User, phone: string, imageBuffer: Buffer): Promise<void> {
    try {
      // Upload da imagem
      const imageUrl = await this.uploadService.uploadReceiptImage(imageBuffer, 'expense.jpg');
      
      // Criar despesa
      const expenseData = {
        user_id: user.id,
        amount: extractedData.amount,
        original_amount: extractedData.original_amount,
        discount_amount: extractedData.discount_amount,
        category: extractedData.category,
        date: extractedData.date,
        image_url: imageUrl,
        description: extractedData.description,
        payment_method: extractedData.payment_method,
        store_name: extractedData.store_name,
        store_cnpj: extractedData.store_cnpj,
        store_address: extractedData.store_address,
        document_type: extractedData.document_type,
        document_number: extractedData.document_number,
      };

      // TODO: Implementar criação de despesa para Chat LawX
      // const expense = await this.expensesService.create(expenseData);
      
      // Incrementar contador de uso
      await this.usageService.incrementUsage(user.id, 'consultation');
      
      // Enviar confirmação
      // TODO: Implementar confirmação de despesa para Chat LawX
      // const confirmationMessage = this.formatExpenseConfirmation(expense);
      const confirmationMessage = '✅ Consulta jurídica registrada com sucesso!';
      await this.sendMessage(phone, confirmationMessage);
      
      this.logger.log(`✅ Despesa criada com sucesso para usuário ${user.id}`);
      
    } catch (error) {
      this.logger.error('❌ Erro ao processar despesa:', error);
      await this.sendMessage(phone, '❌ Erro ao processar a despesa. Tente novamente.');
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

  /**
   * Processa consulta jurídica
   */
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
      await this.sendMessage(phone, '❌ Erro ao processar sua consulta jurídica. Tente novamente.');
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
      `• Pesquisa de jurisprudência\n\n` +
      `💡 **Como usar:**\n` +
      `• Digite sua pergunta jurídica\n` +
      `• Envie foto de documento para análise\n` +
      `• Use "upgrade" para ver planos premium\n\n` +
      `⚠️ *Lembre-se: Este é um assistente informativo. Para casos específicos, consulte um advogado.*`;
    
    await this.sendMessage(phone, menu);
  }

  private async handleFinancialEntry(text: string, user: User, phone: string, financialEntry: any): Promise<void> {
    try {
      this.logger.log('💰 Processando lançamento financeiro:', financialEntry);

      // Extrair dados do texto
      const extractedData = await this.aiService.extractDataFromText(text);
      
      // Verificar se a classificação da IA coincide com a detecção
      if (extractedData.document_classification !== financialEntry.type) {
        this.logger.warn('⚠️ Classificação divergente, usando detecção inicial');
        extractedData.document_classification = financialEntry.type;
      }

      // Processar baseado no tipo
      if (extractedData.document_classification === 'revenue') {
        await this.handleRevenueText(extractedData, user, phone);
      } else {
        await this.handleExpenseText(extractedData, user, phone);
      }

    } catch (error) {
      this.logger.error('❌ Erro ao processar lançamento financeiro:', error);
      await this.sendMessage(phone, '❌ Erro ao processar o lançamento. Tente novamente.');
    }
  }

  private async handleRevenueText(extractedData: any, user: User, phone: string): Promise<void> {
    try {
      // Verificar limites de receitas
      const limits = await this.usageService.checkLimits(user.id, 'consultation');
      if (!limits.allowed) {
        await this.sendMessage(phone, limits.message);
        return;
      }

      // Criar receita
      const revenueData = {
        user_id: user.id,
        amount: extractedData.amount,
        original_amount: extractedData.original_amount,
        discount_amount: extractedData.discount_amount,
        category: extractedData.category,
        date: extractedData.date,
        image_url: '', // Não há imagem para lançamento via texto
        description: extractedData.description,
        payment_method: extractedData.payment_method,
        payer_name: extractedData.payer_name,
        payer_cnpj: extractedData.payer_cnpj,
        payer_address: extractedData.payer_address,
        document_type: extractedData.document_type,
        document_number: extractedData.document_number,
        revenue_type: extractedData.revenue_type,
        source: extractedData.source,
      };

      // TODO: Implementar criação de receita para Chat LawX
      // const revenue = await this.revenuesService.create(revenueData);
      
      // Incrementar contador de uso
      await this.usageService.incrementUsage(user.id, 'consultation');
      
      // Enviar confirmação
      // TODO: Implementar confirmação de receita para Chat LawX
      // const confirmationMessage = this.formatRevenueConfirmation(revenue);
      const confirmationMessage = '✅ Consulta jurídica registrada com sucesso!';
      await this.sendMessage(phone, confirmationMessage);
      
      this.logger.log(`✅ Receita criada via texto para usuário ${user.id}`);
      
    } catch (error) {
      this.logger.error('❌ Erro ao processar receita via texto:', error);
      await this.sendMessage(phone, '❌ Erro ao processar a receita. Tente novamente.');
    }
  }

  private async handleExpenseText(extractedData: any, user: User, phone: string): Promise<void> {
    try {
      // Verificar limites de despesas
      const limits = await this.usageService.checkLimits(user.id, 'consultation');
      if (!limits.allowed) {
        await this.sendMessage(phone, limits.message);
        await this.sendMessage(phone, 'Qual o plano atenderia suas necessidades nesse momento?');
        return;
      }

      // Criar despesa
      const expenseData = {
        user_id: user.id,
        amount: extractedData.amount,
        original_amount: extractedData.original_amount,
        discount_amount: extractedData.discount_amount,
        category: extractedData.category,
        date: extractedData.date,
        image_url: '', // Não há imagem para lançamento via texto
        description: extractedData.description,
        payment_method: extractedData.payment_method,
        store_name: extractedData.store_name,
        store_cnpj: extractedData.store_cnpj,
        store_address: extractedData.store_address,
        document_type: extractedData.document_type,
        document_number: extractedData.document_number,
      };

      // TODO: Implementar criação de despesa para Chat LawX
      // const expense = await this.expensesService.create(expenseData);
      
      // Incrementar contador de uso
      await this.usageService.incrementUsage(user.id, 'consultation');
      
      // Enviar confirmação
      // TODO: Implementar confirmação de despesa para Chat LawX
      // const confirmationMessage = this.formatExpenseConfirmation(expense);
      const confirmationMessage = '✅ Consulta jurídica registrada com sucesso!';
      await this.sendMessage(phone, confirmationMessage);
      
      this.logger.log(`✅ Despesa criada via texto para usuário ${user.id}`);
      
    } catch (error) {
      this.logger.error('❌ Erro ao processar despesa via texto:', error);
      await this.sendMessage(phone, '❌ Erro ao processar a despesa. Tente novamente.');
    }
  }

  private async detectReportIntent(text: string): Promise<{ isReportRequest: boolean; confidence: number; intent: string } | null> {
    try {
      this.logger.log('📊 Detectando intent de relatório:', text);
      
      // Usar IA para detectar se é uma solicitação de relatório financeiro
      const reportDetection = await this.aiService.detectReportIntent(text);
      
      if (reportDetection.isReportRequest && reportDetection.confidence > 0.6) {
        this.logger.log('📊 Intent de relatório detectado:', reportDetection);
        return reportDetection;
      }
      
      return null;
    } catch (error) {
      this.logger.error('❌ Erro ao detectar intent de relatório:', error);
      return null;
    }
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
      const aiAnalysis = await this.aiService.analyzeUpgradeIntent(text, context);
      
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
      return this.fallbackUpgradeIntentDetection(text, session, state);
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
      
      const newUpgradeIntent = await this.aiService.detectNewUpgradeIntent(text);
      
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

  private fallbackUpgradeIntentDetection(text: string, session: any, state: any): {
    isUpgradeIntent: boolean;
    confidence: number;
    intent: 'new_upgrade' | 'continue_upgrade' | 'payment_confirmation' | 'frequency_selection' | 'plan_selection' | 'cancel_upgrade';
    context?: any;
  } {
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

  private async handleReportRedirect(phone: string, reportIntent: { isReportRequest: boolean; confidence: number; intent: string }): Promise<void> {
    try {
      this.logger.log('📊 Redirecionando para app:', reportIntent);
      
      const appMessage = `📱 **Relatórios e Dashboard Completo!**

🎯 **Para acessar seus relatórios financeiros completos, baixe nosso app:**

🍎 **App Store (iOS):**
https://apps.apple.com/app/mepoupebot

🤖 **Google Play (Android):**
https://play.google.com/store/apps/details?id=com.mepoupebot.app

📊 **No app você terá acesso a:**
• Relatórios detalhados de receitas e despesas
• Gráficos e análises visuais
• Filtros por período e categoria
• Exportação de dados
• Dashboard completo em tempo real
• Notificações e alertas

💡 **Dica:** O app é gratuito e sincroniza automaticamente com suas mensagens do WhatsApp!`;

      await this.sendMessage(phone, appMessage);
      this.logger.log(`✅ Redirecionamento para app enviado para ${phone}`);

    } catch (error) {
      this.logger.error('❌ Erro ao redirecionar para app:', error);
      await this.sendMessage(phone, '❌ Erro ao processar solicitação. Tente novamente.');
    }
  }

  private async showMenu(phone: string): Promise<void> {
    const menuMessage = `🤖 *MENU DO MEPOUPEBOT* 🤖

*FUNCIONALIDADES DISPONÍVEIS:*

📸 *REGISTRAR DESPESAS/RECEITAS:*
• Envie fotos de comprovantes, recibos, notas fiscais
• Envie áudios descrevendo suas despesas ou receitas  
• Digite mensagens como "Compra no mercado R$ 150" ou "Salário R$ 3000"

📊 *RELATÓRIOS E CONSULTAS:*
• "hoje" ou "gastos de hoje" - Ver despesas de hoje
• "ontem" ou "gastos de ontem" - Ver despesas de ontem
• "semana" ou "gastos da semana" - Relatório semanal
• "mês" ou "gastos do mês" - Relatório mensal
• "22/07/2025" - Data específica
• "receitas" - Ver suas receitas
• "balanço" - Resumo geral

💡 *DICAS E AJUDA:*
• "dicas" - Dicas de economia
• "como economizar" - Sugestões práticas
• "orçamento" - Ajuda com planejamento

🚀 *UPGRADE E PLANOS:*
• "upgrade" ou "planos" - Conhecer planos premium
• "limites" - Ver seus limites atuais

*Como usar:* Basta digitar qualquer comando acima ou conversar naturalmente comigo! 😊

*Exemplo:* "Quanto gastei hoje?" ou "Preciso de dicas para economizar"`;

    await this.sendMessage(phone, menuMessage);
  }

  private async handleReportRequest(phone: string, userId: string, reportRequest: { type: 'today' | 'week' | 'month' | 'custom' | 'status'; date?: string }, originalMessage: string): Promise<void> {
    try {
      // Verificar limites de relatórios
      const limits = await this.usageService.checkLimits(userId, 'consultation');
      if (!limits.allowed) {
        await this.sendMessage(phone, limits.message);
        return;
      }

      // Incrementar contador de uso
      await this.usageService.incrementUsage(userId, 'consultation');

      let reportData: any;
      let reportMessage: string;

      if (reportRequest.type === 'status') {
        // Relatório de status/uso
        const usageSummary = await this.usageService.getUsageSummary(userId);
        reportMessage = await this.aiService.generateResponse(originalMessage, usageSummary);
      } else {
        // Relatório financeiro completo (receitas + despesas)
        // TODO: Implementar relatórios para Chat LawX
        // const [expenseReport, revenueReport] = await Promise.all([
        //   this.expensesService.generateExpenseReport(userId, reportRequest.type, reportRequest.date),
        //   this.revenuesService.generateRevenueReport(userId, reportRequest.type, reportRequest.date)
        // ]);

        // TODO: Implementar relatório financeiro para Chat LawX
        // const financialReportData = {
        //   period: expenseReport.period,
        //   total_revenue: revenueReport.total || 0,
        //   total_expenses: expenseReport.total || 0,
        //   net_income: (revenueReport.total || 0) - (expenseReport.total || 0),
        //   revenue_by_category: revenueReport.byCategory || {},
        //   expense_by_category: expenseReport.byCategory || {},
        //   revenue_count: revenueReport.count || 0,
        //   expense_count: expenseReport.count || 0,
        //   top_revenues: revenueReport.topRevenues || [],
        //   top_expenses: expenseReport.topExpenses || [],
        //   revenue_by_payment_method: revenueReport.byPaymentMethod || {},
        //   expense_by_payment_method: expenseReport.byPaymentMethod || {},
        // };

        // reportMessage = await this.aiService.generateFinancialReportResponse(financialReportData, originalMessage);
        reportMessage = '📊 Relatório de uso do Chat LawX:\n\n' + await this.aiService.generateResponse(originalMessage, 'Relatório de uso do sistema');
      }

      await this.sendMessage(phone, reportMessage);
      this.logger.log(`✅ Relatório enviado para usuário ${userId}`);

    } catch (error) {
      this.logger.error('❌ Erro ao gerar relatório:', error);
      await this.sendMessage(phone, '❌ Erro ao gerar o relatório. Tente novamente.');
    }
  }

  /**
   * Formata data preservando o dia original (resolve problema de timezone)
   */
  private formatDatePreservingDay(dateInput: string | Date): string {
    try {
      if (typeof dateInput === 'string') {
        // Se é string, converter para Date preservando a data original
        this.logger.log('🔍 Data original:', dateInput);
        
        // Extrair componentes da data (YYYY-MM-DD)
        const [year, month, day] = dateInput.split('-').map(Number);
        
        // Criar Date com componentes locais (não UTC)
        const dataObj = new Date(year, month - 1, day); // month - 1 porque getMonth() retorna 0-11
        this.logger.log('🔍 Data convertida:', dataObj.toISOString());
        
        if (isNaN(dataObj.getTime())) {
          throw new Error('Data inválida');
        }
        
        const formatador = new Intl.DateTimeFormat("pt-BR");
        const dataFormatada = formatador.format(dataObj);
        this.logger.log('🔍 Data formatada:', dataFormatada);
        return dataFormatada;
      } else {
        // Se já é Date, formatar diretamente
        const formatador = new Intl.DateTimeFormat("pt-BR");
        const dataFormatada = formatador.format(dateInput);
        this.logger.log('🔍 Data formatada:', dataFormatada);
        return dataFormatada;
      }
    } catch (error) {
      this.logger.warn('⚠️ Erro ao formatar data, usando data atual:', error);
      const formatador = new Intl.DateTimeFormat("pt-BR");
      return formatador.format(new Date());
    }
  }

  private formatExpenseConfirmation(data: any): string {
    // Formatação monetária profissional
    const amount = new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(data.amount);

    const originalAmount = data.original_amount && data.original_amount > data.amount
      ? new Intl.NumberFormat('pt-BR', {
          style: 'currency',
          currency: 'BRL'
        }).format(data.original_amount)
      : null;

    const discountAmount = data.discount_amount && data.discount_amount > 0
      ? new Intl.NumberFormat('pt-BR', {
          style: 'currency',
          currency: 'BRL'
        }).format(data.discount_amount)
      : data.original_amount && data.original_amount > data.amount
        ? new Intl.NumberFormat('pt-BR', {
            style: 'currency',
            currency: 'BRL'
          }).format(data.original_amount - data.amount)
        : null;

    let message = `✅ *DESPESA REGISTRADA COM SUCESSO!*\n\n`;
    
    // Usar método auxiliar para formatação de data
    const dataFormatada = this.formatDatePreservingDay(data.date);
    
    // Informações básicas
    message += `💰 *Valor:* ${amount}\n`;
    
    // Informações de desconto se houver
    if (originalAmount && discountAmount) {
      message += `💳 *Valor original:* ${originalAmount}\n`;
      message += `🎯 *Desconto:* ${discountAmount}\n`;
    }
    
    // Informações da loja
    if (data.store_name) {
      message += `🏪 *Loja:* ${data.store_name}\n`;
    }
    
    // Categoria e data
    message += `📂 *Categoria:* ${data.category}\n`;
    message += `📅 *Data:* ${dataFormatada}\n`;
    
    // Forma de pagamento
    if (data.payment_method) {
      message += `💳 *Pagamento:* ${data.payment_method}\n`;
    }
    
    // Descrição
    message += `📝 *Descrição:* ${data.description}\n\n`;
    
    // Documento fiscal se disponível
    if (data.document_type && data.document_number) {
      message += `📄 ${data.document_type}: ${data.document_number}\n\n`;
    }
    
    message += `*Parabéns! Sua despesa foi salva automaticamente!* Envie mais comprovantes quando quiser.`;
    
    return message;
  }

  private formatRevenueConfirmation(data: any): string {
    const amount = new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(data.amount);

    const originalAmount = data.original_amount && data.original_amount !== data.amount
      ? new Intl.NumberFormat('pt-BR', {
          style: 'currency',
          currency: 'BRL'
        }).format(data.original_amount)
      : null;

    const discountAmount = data.discount_amount && data.discount_amount > 0
      ? new Intl.NumberFormat('pt-BR', {
          style: 'currency',
          currency: 'BRL'
        }).format(data.discount_amount)
      : null;

      // Usar método auxiliar para formatação de data
      const dataFormatada = this.formatDatePreservingDay(data.date);

    let message = `✅ *RECEITA REGISTRADA COM SUCESSO!*\n\n`;
    message += `💰 *Valor:* ${amount}\n`;
    
    if (originalAmount && discountAmount) {
      message += `📊 *Valor Original:* ${originalAmount}\n`;
      message += `🎯 *Desconto:* ${discountAmount}\n`;
    }
    
    message += `📅 *Data:* ${dataFormatada}\n`;
    message += `📂 *Categoria:* ${data.category}\n`;
    message += `📝 *Descrição:* ${data.description}\n`;
    
    if (data.payment_method) {
      message += `💳 *Forma de Recebimento:* ${data.payment_method}\n`;
    }
    
    if (data.payer_name) {
      message += `🏢 *Pagador:* ${data.payer_name}\n`;
    }
    
    if (data.revenue_type) {
      const revenueTypeLabels = {
        'salary': 'Salário',
        'freelance': 'Freelance',
        'sale': 'Venda',
        'investment': 'Investimento',
        'refund': 'Reembolso',
        'transfer': 'Transferência',
        'rent': 'Aluguel',
        'commission': 'Comissão',
        'other': 'Outro'
      };
      message += `🎯 *Tipo:* ${revenueTypeLabels[data.revenue_type] || data.revenue_type}\n`;
    }
    
    if (data.source) {
      message += `📌 *Origem:* ${data.source}\n`;
    }

    message += `\n🎉 *Parabéns! Sua receita foi registrada automaticamente.*\n`;

    return message;
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
      isInUpgradeFlow: false,
      isInRegistrationFlow: false,
      upgradeStep: 'introduction',
      registrationStep: 'introduction',
    };
  }

  private setConversationState(phone: string, state: Partial<ConversationState>): void {
    const currentState = this.conversationStates.get(phone) || {
      isWaitingForName: false,
      isWaitingForEmail: false,
      isWaitingForConfirmation: false,
      isInUpgradeFlow: false,
      isInRegistrationFlow: false,
      registrationStep: 'introduction',
      upgradeStep: 'introduction'
    };
    
    this.conversationStates.set(phone, { ...currentState, ...state });
  }

  private clearConversationState(phone: string): void {
    this.conversationStates.delete(phone);
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
        
        // Criar sessão inicial
        const user = await this.usersService.getOrCreateUser(phone);
        await this.upgradeSessionsService.createSession({
          user_id: userId,
          phone: phone,
          plan_name: '',
          billing_cycle: 'monthly',
          amount: 0,
          current_step: 'plan_selection'
        });
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
        session = await this.upgradeSessionsService.createSession({
          user_id: userId,
          phone: phone,
          plan_name: selectedPlan.name,
          billing_cycle: 'monthly', // Temporário, será atualizado
          amount: 0, // Será calculado quando escolher frequência
          current_step: 'plan_selection'
        });
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

  private async handleAudioMessage(message: any, user: User, phone: string): Promise<void> {
    try {
      this.logger.log('🎵 Processando mensagem de áudio...');

      this.logger.log('🎵 Mensagem de áudio:', JSON.stringify(message, null, 2));
      
      // Enviar mensagem de processamento
      await this.sendMessage(phone, '🎵 Processando seu áudio... Aguarde um momento.');
      
      // Processar áudio base64
      const audioBuffer = await this.processAudioBase64(message);
      if (!audioBuffer) {
        await this.sendMessage(phone, '❌ Não consegui processar o áudio. Tente novamente.');
        return;
      }

      // Upload do áudio para Supabase Storage
      const audioUrl = await this.uploadService.uploadAudioFile(audioBuffer, 'audio.mp3');
      
      // Processar áudio para extrair dados financeiros
      const extractedData = await this.aiService.processAudioForFinancialEntry(audioBuffer);
      
      // Verificar limites baseado na classificação
      if (extractedData.document_classification === 'revenue') {
        // Verificar limite de receitas
        const revenueLimits = await this.usageService.checkLimits(user.id, 'consultation');
        if (!revenueLimits.allowed) {
          await this.sendMessage(phone, revenueLimits.message);
          return;
        }
        await this.handleRevenueAudio(extractedData, user, phone, audioUrl);
      } else {
        // Verificar limite de despesas
        const expenseLimits = await this.usageService.checkLimits(user.id, 'consultation');
        if (!expenseLimits.allowed) {
          await this.sendMessage(phone, expenseLimits.message);
          return;
        }
        await this.handleExpenseAudio(extractedData, user, phone, audioUrl);
      }
      
    } catch (error) {
      this.logger.error('❌ Erro ao processar áudio:', error);
      
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

  /**
   * Processa áudio em base64 e converte para buffer
   */
  private async processAudioBase64(message: any): Promise<Buffer | null> {
    try {
      this.logger.log('🎵 Processando áudio base64...');
      
      // Log da estrutura completa da mensagem para debug
      this.logger.log('🔍 Estrutura da mensagem:', JSON.stringify(message, null, 2));
      
      const audioMessage = message.message?.audioMessage;
      if (!audioMessage) {
        this.logger.error('❌ Mensagem de áudio não encontrada');
        return null;
      }

      // Verificar se temos base64 na mensagem (nível da mensagem, não dentro de audioMessage)
      if (message.base64) {
        this.logger.log('✅ Base64 encontrado na mensagem');
        const buffer = Buffer.from(message.base64, 'base64');
        
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

  private async handleRevenueAudio(extractedData: any, user: User, phone: string, audioUrl: string): Promise<void> {
    try {
      // Criar receita
      const revenueData = {
        user_id: user.id,
        amount: extractedData.amount,
        original_amount: extractedData.original_amount,
        discount_amount: extractedData.discount_amount,
        category: extractedData.category,
        date: extractedData.date,
        image_url: audioUrl, // Usar URL do áudio
        description: extractedData.description,
        payment_method: extractedData.payment_method,
        payer_name: extractedData.payer_name,
        payer_cnpj: extractedData.payer_cnpj,
        payer_address: extractedData.payer_address,
        document_type: extractedData.document_type,
        document_number: extractedData.document_number,
        revenue_type: extractedData.revenue_type,
        source: extractedData.source,
      };

      // TODO: Implementar criação de receita para Chat LawX
      // const revenue = await this.revenuesService.create(revenueData);
      
      // Incrementar contador de uso
      await this.usageService.incrementUsage(user.id, 'consultation');
      
      // Enviar confirmação
      // TODO: Implementar confirmação de receita para Chat LawX
      // const confirmationMessage = this.formatRevenueConfirmation(revenue);
      const confirmationMessage = '✅ Consulta jurídica registrada com sucesso!';
      await this.sendMessage(phone, confirmationMessage);
      
      this.logger.log(`✅ Receita criada via áudio para usuário ${user.id}`);
      
    } catch (error) {
      this.logger.error('❌ Erro ao processar receita via áudio:', error);
      await this.sendMessage(phone, '❌ Erro ao processar a receita. Tente novamente.');
    }
  }

  private async handleExpenseAudio(extractedData: any, user: User, phone: string, audioUrl: string): Promise<void> {
    try {
      this.logger.log('💰 Iniciando processamento de despesa via áudio...');
      this.logger.log('💰 Dados extraídos:', JSON.stringify(extractedData, null, 2));
      this.logger.log('💰 URL do áudio:', audioUrl);
      this.logger.log('💰 ID do usuário:', user.id);

      // Criar despesa
      const expenseData = {
        user_id: user.id,
        amount: extractedData.amount,
        original_amount: extractedData.original_amount,
        discount_amount: extractedData.discount_amount,
        category: extractedData.category,
        date: extractedData.date,
        image_url: audioUrl, // Usar URL do áudio
        description: extractedData.description,
        payment_method: extractedData.payment_method,
        store_name: extractedData.store_name,
        store_cnpj: extractedData.store_cnpj,
        store_address: extractedData.store_address,
        document_type: extractedData.document_type,
        document_number: extractedData.document_number,
      };

      this.logger.log('💰 Dados da despesa a serem criados:', JSON.stringify(expenseData, null, 2));

      // TODO: Implementar criação de despesa para Chat LawX
      // const expense = await this.expensesService.create(expenseData);
      this.logger.log('💰 Consulta jurídica criada com sucesso');
      
      // Incrementar contador de uso
      await this.usageService.incrementUsage(user.id, 'consultation');
      this.logger.log('💰 Contador de uso incrementado');
      
      // Enviar confirmação
      // TODO: Implementar confirmação de despesa para Chat LawX
      // const confirmationMessage = this.formatExpenseConfirmation(expense);
      const confirmationMessage = '✅ Consulta jurídica registrada com sucesso!';
      await this.sendMessage(phone, confirmationMessage);
      
      this.logger.log(`✅ Despesa criada via áudio para usuário ${user.id}`);
      
    } catch (error) {
      this.logger.error('❌ Erro ao processar despesa via áudio:', error);
      this.logger.error('❌ Stack trace:', error.stack);
      await this.sendMessage(phone, '❌ Erro ao processar a despesa. Tente novamente.');
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

      // Extrair o ID da mensagem da URL
      const urlMatch = audioMessage.url.match(/\/([^\/]+)\.enc/);
      if (!urlMatch) {
        this.logger.warn('⚠️ Não foi possível extrair ID da mensagem da URL');
        return null;
      }

      const messageId = urlMatch[1];
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
            messageId: messageId,
            remoteJid: audioMessage.remoteJid || '554892060485@s.whatsapp.net'
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
      const aiAnalysis = await this.aiService.analyzeUpgradeIntent(userMessage, context);
      
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
      const frequencyAnalysis = await this.aiService.detectFrequencySelection(userMessage);
      
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
      const response = await this.aiService.generateUpgradeResponse(userMessage, context);
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
} 
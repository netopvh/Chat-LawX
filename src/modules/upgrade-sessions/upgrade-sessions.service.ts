import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { PrismaService } from '../prisma/prisma.service';
import { PlansService } from '../plans/plans.service';
import { StripeService } from '../stripe/stripe.service';
import { JurisdictionService } from '../jurisdiction/jurisdiction.service';
import { 
  UpgradeSession, 
  CreateUpgradeSessionDto, 
  UpdateUpgradeSessionDto,
  UpgradeAttempt,
  CreateUpgradeAttemptDto,
  UpgradeIntent
} from './upgrade-sessions.interface';

@Injectable()
export class UpgradeSessionsService {
  private readonly logger = new Logger(UpgradeSessionsService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly prismaService: PrismaService,
    private readonly plansService: PlansService,
    private readonly stripeService: StripeService,
    private readonly jurisdictionService: JurisdictionService
  ) {}

  private isBrazil(jurisdiction?: string): boolean {
    return jurisdiction === 'BR';
  }

  private toSnakeCaseSession(prismaSession: any): UpgradeSession {
    if (!prismaSession) return null as unknown as UpgradeSession;
    return {
      id: prismaSession.id,
      user_id: prismaSession.userId,
      phone: prismaSession.phone,
      plan_name: prismaSession.planName,
      billing_cycle: prismaSession.billingCycle,
      amount: prismaSession.amount,
      status: prismaSession.status,
      current_step: prismaSession.currentStep,
      attempts_count: prismaSession.attemptsCount,
      last_attempt_at: prismaSession.lastAttemptAt ? prismaSession.lastAttemptAt.toISOString() : null,
      jurisdiction: prismaSession.jurisdiction,
      stripe_checkout_url: prismaSession.stripeCheckoutUrl,
      stripe_checkout_session_id: prismaSession.stripeCheckoutSessionId,
      completed_at: prismaSession.completedAt ? prismaSession.completedAt.toISOString() : undefined,
      payment_confirmed_at: prismaSession.paymentConfirmedAt ? prismaSession.paymentConfirmedAt.toISOString() : undefined,
      payment_failed_at: prismaSession.paymentFailedAt ? prismaSession.paymentFailedAt.toISOString() : undefined,
      created_at: prismaSession.createdAt.toISOString(),
      updated_at: prismaSession.updatedAt.toISOString(),
      expires_at: prismaSession.expiresAt.toISOString(),
    };
  }

  async createSession(sessionData: CreateUpgradeSessionDto): Promise<UpgradeSession> {
    try {
      this.logger.log(`Criando sessão de upgrade para usuário ${sessionData.user_id}`);

      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 1); // Expira em 1 hora

      // Detectar jurisdição (se não vier informada, usar phone)
      const jurisdiction = sessionData.jurisdiction || this.jurisdictionService.detectJurisdiction(sessionData.phone).jurisdiction;

      if (this.isBrazil(jurisdiction)) {
        const { data, error } = await this.supabaseService.getClient()
          .from('upgrade_sessions')
          .insert({
            user_id: sessionData.user_id,
            phone: sessionData.phone,
            plan_name: sessionData.plan_name,
            billing_cycle: sessionData.billing_cycle,
            amount: sessionData.amount,
            current_step: sessionData.current_step,
            status: 'active',
            attempts_count: 0,
            expires_at: expiresAt.toISOString(),
            jurisdiction
          })
          .select()
          .single();

        if (error) {
          this.logger.error('Erro ao criar sessão de upgrade (Supabase):', error);
          throw new Error(`Erro ao criar sessão: ${error.message}`);
        }

        this.logger.log(`Sessão de upgrade criada (Supabase): ${data.id}`);
        return data;
      }

      // PT/ES via Prisma
      const prismaSession = await (this.prismaService as any).upgradeSession.create({
        data: {
          userId: sessionData.user_id,
          phone: sessionData.phone,
          planName: sessionData.plan_name || '',
          billingCycle: sessionData.billing_cycle,
          amount: sessionData.amount,
          currentStep: sessionData.current_step,
          status: 'active',
          attemptsCount: 0,
          expiresAt,
          jurisdiction,
        }
      });
      this.logger.log(`Sessão de upgrade criada (Prisma): ${prismaSession.id}`);
      return this.toSnakeCaseSession(prismaSession);
    } catch (error) {
      this.logger.error('Erro ao criar sessão de upgrade:', error);
      throw error;
    }
  }

  async getActiveSession(userId: string, jurisdiction?: string): Promise<UpgradeSession | null> {
    try {
      this.logger.log(`Buscando sessão ativa para usuário ${userId}`);

      const now = new Date().toISOString();

      // 1) Tentar via Prisma (PT/ES)
      const prismaActive = await (this.prismaService as any).upgradeSession.findFirst({
        where: {
          userId,
          status: 'active',
          expiresAt: { gt: new Date(now) }
        },
        orderBy: { createdAt: 'desc' }
      });

      if (prismaActive) {
        const session = this.toSnakeCaseSession(prismaActive);
        this.logger.log(`Sessão ativa encontrada (Prisma): ${session.id}`);
        return session;
      }

      // Se a jurisdição é explicitamente não-BR, não tentar Supabase
      if (jurisdiction && !this.isBrazil(jurisdiction)) {
        this.logger.log(`Nenhuma sessão ativa (Prisma) para jurisdição ${jurisdiction}`);
        return null;
      }

      // 2) Fallback Supabase (BR)
      const { data, error } = await this.supabaseService.getClient()
        .from('upgrade_sessions')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'active')
        .gt('expires_at', now)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          this.logger.log(`Nenhuma sessão ativa encontrada para usuário ${userId}`);
          return null;
        }
        this.logger.error('Erro ao buscar sessão ativa (Supabase):', error);
        throw new Error(`Erro ao buscar sessão: ${error.message}`);
      }

      this.logger.log(`Sessão ativa encontrada (Supabase): ${data.id}`);
      return data;
    } catch (error) {
      this.logger.error('Erro ao buscar sessão ativa:', error);
      return null;
    }
  }

  async updateSession(sessionId: string, updateData: UpdateUpgradeSessionDto): Promise<UpgradeSession> {
    try {
      this.logger.log(`Atualizando sessão ${sessionId}`);

      const updatePayload: any = {
        ...updateData,
        updated_at: new Date().toISOString()
      };

      // Tentar atualizar no Prisma primeiro
      const prismaExisting = await (this.prismaService as any).upgradeSession.findUnique({ where: { id: sessionId } });
      if (prismaExisting) {
        const prismaUpdate: any = {};
        if (updateData.status) prismaUpdate.status = updateData.status;
        if (updateData.current_step) prismaUpdate.currentStep = updateData.current_step;
        if (typeof updateData.attempts_count === 'number') prismaUpdate.attemptsCount = updateData.attempts_count;
        if (updateData.last_attempt_at) prismaUpdate.lastAttemptAt = new Date(updateData.last_attempt_at);
        if (updateData.plan_name !== undefined) prismaUpdate.planName = updateData.plan_name;
        if (updateData.billing_cycle) prismaUpdate.billingCycle = updateData.billing_cycle;
        if (typeof updateData.amount === 'number') prismaUpdate.amount = updateData.amount;
        if (updateData.jurisdiction) prismaUpdate.jurisdiction = updateData.jurisdiction;
        if (updateData.stripe_checkout_url) prismaUpdate.stripeCheckoutUrl = updateData.stripe_checkout_url;
        if (updateData.stripe_checkout_session_id) prismaUpdate.stripeCheckoutSessionId = updateData.stripe_checkout_session_id;
        if (updateData.completed_at) prismaUpdate.completedAt = new Date(updateData.completed_at);
        if (updateData.payment_confirmed_at) prismaUpdate.paymentConfirmedAt = new Date(updateData.payment_confirmed_at);
        if (updateData.payment_failed_at) prismaUpdate.paymentFailedAt = new Date(updateData.payment_failed_at);

        const updated = await (this.prismaService as any).upgradeSession.update({ where: { id: sessionId }, data: prismaUpdate });
        this.logger.log(`Sessão atualizada (Prisma): ${sessionId}`);
        return this.toSnakeCaseSession(updated);
      }

      // Fallback Supabase
      const { data, error } = await this.supabaseService.getClient()
        .from('upgrade_sessions')
        .update(updatePayload)
        .eq('id', sessionId)
        .select()
        .single();

      if (error) {
        this.logger.error('Erro ao atualizar sessão (Supabase):', error);
        throw new Error(`Erro ao atualizar sessão: ${error.message}`);
      }

      this.logger.log(`Sessão atualizada (Supabase): ${sessionId}`);
      return data;
    } catch (error) {
      this.logger.error('Erro ao atualizar sessão:', error);
      throw error;
    }
  }

  async updateStep(sessionId: string, step: string): Promise<void> {
    try {
      await this.updateSession(sessionId, { current_step: step as any });
      this.logger.log(`Passo atualizado para sessão ${sessionId}: ${step}`);
    } catch (error) {
      this.logger.error('Erro ao atualizar passo:', error);
      throw error;
    }
  }

  async incrementAttempts(sessionId: string): Promise<void> {
    try {
      this.logger.log(`Incrementando tentativas para sessão ${sessionId}`);
      // Tentar Prisma
      const prismaExisting = await (this.prismaService as any).upgradeSession.findUnique({ where: { id: sessionId } });
      if (prismaExisting) {
        const updated = await (this.prismaService as any).upgradeSession.update({
          where: { id: sessionId },
          data: {
            attemptsCount: (prismaExisting.attemptsCount || 0) + 1,
            lastAttemptAt: new Date(),
          }
        });
        this.logger.log(`Tentativas incrementadas (Prisma) para sessão ${sessionId}: ${updated.attemptsCount}`);
        return;
      }

      // Fallback Supabase
      const { data: currentSession, error: fetchError } = await this.supabaseService.getClient()
        .from('upgrade_sessions')
        .select('attempts_count')
        .eq('id', sessionId)
        .single();

      if (fetchError) {
        this.logger.error('Erro ao buscar sessão para incrementar tentativas (Supabase):', fetchError);
        return;
      }

      const newAttemptsCount = (currentSession.attempts_count || 0) + 1;
      await this.updateSession(sessionId, {
        attempts_count: newAttemptsCount,
        last_attempt_at: new Date().toISOString()
      });

      this.logger.log(`Tentativas incrementadas (Supabase) para sessão ${sessionId}: ${newAttemptsCount}`);
    } catch (error) {
      this.logger.error('Erro ao incrementar tentativas:', error);
    }
  }

  async completeSession(sessionId: string): Promise<void> {
    try {
      await this.updateSession(sessionId, { 
        status: 'completed',
        current_step: 'confirmation'
      });
      this.logger.log(`Sessão completada: ${sessionId}`);
    } catch (error) {
      this.logger.error('Erro ao completar sessão:', error);
      throw error;
    }
  }

  async cancelSession(sessionId: string): Promise<void> {
    try {
      await this.updateSession(sessionId, { 
        status: 'cancelled'
      });
      this.logger.log(`Sessão cancelada: ${sessionId}`);
    } catch (error) {
      this.logger.error('Erro ao cancelar sessão:', error);
      throw error;
    }
  }

  async failSession(sessionId: string): Promise<void> {
    try {
      await this.updateSession(sessionId, { 
        status: 'failed'
      });
      this.logger.log(`Sessão marcada como falha: ${sessionId}`);
    } catch (error) {
      this.logger.error('Erro ao marcar sessão como falha:', error);
      throw error;
    }
  }

  async cleanupExpiredSessions(): Promise<void> {
    try {
      this.logger.log('Limpando sessões expiradas...');

      const now = new Date().toISOString();
      // Prisma
      await (this.prismaService as any).upgradeSession.updateMany({
        where: { status: 'active', expiresAt: { lt: new Date(now) } },
        data: { status: 'expired', updatedAt: new Date() }
      });
      // Supabase
      const { error } = await this.supabaseService.getClient()
        .from('upgrade_sessions')
        .update({ 
          status: 'expired',
          updated_at: now
        })
        .eq('status', 'active')
        .lt('expires_at', now);

      if (error) {
        this.logger.error('Erro ao limpar sessões expiradas (Supabase):', error);
      }
      this.logger.log('Sessões expiradas limpas com sucesso');
    } catch (error) {
      this.logger.error('Erro ao limpar sessões expiradas:', error);
    }
  }

  async createAttempt(attemptData: CreateUpgradeAttemptDto): Promise<UpgradeAttempt> {
    try {
      this.logger.log(`Criando tentativa para sessão ${attemptData.session_id}`);
      // Tentar Prisma primeiro (PT/ES)
      try {
        const created = await (this.prismaService as any).upgradeAttempt.create({
          data: {
            sessionId: attemptData.session_id,
            step: attemptData.step,
            success: attemptData.success,
            errorMessage: attemptData.error_message,
          }
        });
        this.logger.log(`Tentativa criada (Prisma): ${created.id}`);
        return {
          id: created.id,
          session_id: created.sessionId,
          step: created.step,
          success: created.success,
          error_message: created.errorMessage,
          created_at: created.createdAt.toISOString(),
        };
      } catch (e) {
        this.logger.warn('Falha ao criar tentativa via Prisma, tentando Supabase...', e);
      }

      // Fallback Supabase
      const { data, error } = await this.supabaseService.getClient()
        .from('upgrade_attempts')
        .insert(attemptData)
        .select()
        .single();

      if (error) {
        this.logger.error('Erro ao criar tentativa (Supabase):', error);
        throw new Error(`Erro ao criar tentativa: ${error.message}`);
      }

      this.logger.log(`Tentativa criada (Supabase): ${data.id}`);
      return data;
    } catch (error) {
      this.logger.error('Erro ao criar tentativa:', error);
      throw error;
    }
  }

  async detectUpgradeIntent(text: string, userId: string, phoneNumber?: string): Promise<UpgradeIntent> {
    try {
      // Detectar jurisdição para filtrar planos
      let jurisdiction = 'BR';
      if (phoneNumber) {
        const jurisdictionInfo = this.jurisdictionService.detectJurisdiction(phoneNumber);
        jurisdiction = jurisdictionInfo.jurisdiction;
      }

      const plans = await this.plansService.getUpgradePlansByJurisdiction(jurisdiction);
      const planNames = plans.map(p => p.name.toLowerCase());
      
      const upgradeKeywords = [
        'upgrade', 'assinar', 'plano', 'pago', 'premium', 'pro', 'mensal', 'anual',
        'trocar plano', 'mudar plano', 'quero plano', 'quero assinar',
        ...planNames,
        ...planNames.map(name => `quero o ${name}`),
        ...planNames.map(name => `quero ${name}`)
      ];

      const lowerText = text.toLowerCase();
      const hasUpgradeIntent = upgradeKeywords.some(keyword => lowerText.includes(keyword));
      
      // Verificar se há sessão ativa
      const activeSession = await this.getActiveSession(userId);
      
      return {
        hasActiveSession: !!activeSession,
        session: activeSession || undefined,
        intent: hasUpgradeIntent,
        hasIntent: hasUpgradeIntent,
        confidence: hasUpgradeIntent ? 0.9 : 0.1,
        detectedPlans: planNames.filter(name => lowerText.includes(name))
      };
    } catch (error) {
      this.logger.error('Erro ao detectar intenção de upgrade:', error);
      
      // Fallback para detecção simples
      const fallbackKeywords = [
        'upgrade', 'assinar', 'plano', 'pago', 'premium', 'pro', 'mensal', 'anual',
        'trocar plano', 'mudar plano', 'quero plano', 'quero assinar',
        'pro', 'premium', 'quero o pro', 'quero o premium', 'quero pro', 'quero premium'
      ];
      
      const lowerText = text.toLowerCase();
      const hasUpgradeIntent = fallbackKeywords.some(keyword => lowerText.includes(keyword));
      
      return {
        hasActiveSession: false,
        intent: hasUpgradeIntent,
        hasIntent: hasUpgradeIntent,
        confidence: hasUpgradeIntent ? 0.9 : 0.1,
        detectedPlans: []
      };
    }
  }

  // ===== NOVOS MÉTODOS PARA CHAT LAWX =====

  /**
   * Cria sessão de upgrade com Stripe Checkout
   */
  async createStripeCheckoutSession(
    userId: string,
    planName: string,
    billingCycle: 'monthly' | 'yearly',
    phoneNumber: string,
    userEmail?: string
  ): Promise<{
    session: UpgradeSession;
    checkoutUrl: string;
  }> {
    try {
      // Detectar jurisdição
      const jurisdictionInfo = this.jurisdictionService.detectJurisdiction(phoneNumber);
      const jurisdiction = jurisdictionInfo.jurisdiction;

      // Buscar plano
      const plan = await this.plansService.getPlanByName(planName);
      if (!plan) {
        throw new Error(`Plano ${planName} não encontrado`);
      }

      // Calcular valor
      const amount = billingCycle === 'monthly' ? plan.monthly_price : plan.yearly_price;

      // Criar sessão de upgrade
      const sessionData: CreateUpgradeSessionDto = {
        user_id: userId,
        phone: phoneNumber,
        plan_name: planName,
        billing_cycle: billingCycle,
        amount,
        current_step: 'payment_info',
        jurisdiction
      };

      const session = await this.createSession(sessionData);

      // Criar Stripe Checkout Session
      const stripePriceId = billingCycle === 'monthly' 
        ? plan.stripe_price_id_monthly 
        : plan.stripe_price_id_yearly;

      if (!stripePriceId) {
        throw new Error(`Stripe Price ID não encontrado para ${planName} ${billingCycle}`);
      }

            const checkoutUrl = await this.stripeService.createSimpleCheckoutSession({
              priceId: stripePriceId,
              customerEmail: userEmail,
              metadata: {
                userId,
                sessionId: session.id,
                planName,
                billingCycle,
                jurisdiction
              }
            });

      // Atualizar sessão com URL do checkout
      await this.updateSession(session.id, {
        stripe_checkout_url: checkoutUrl,
        current_step: 'payment_processing'
      });

      return {
        session,
        checkoutUrl
      };
    } catch (error) {
      this.logger.error('Erro ao criar sessão Stripe Checkout:', error);
      throw error;
    }
  }

  /**
   * Processa webhook do Stripe para sessões de upgrade
   */
  async processStripeWebhook(event: any): Promise<void> {
    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await this.handleCheckoutCompleted(event.data.object);
          break;
        case 'checkout.session.expired':
          await this.handleCheckoutExpired(event.data.object);
          break;
        case 'invoice.payment_succeeded':
          await this.handlePaymentSucceeded(event.data.object);
          break;
        case 'invoice.payment_failed':
          await this.handlePaymentFailed(event.data.object);
          break;
        default:
          this.logger.log(`Evento Stripe não processado: ${event.type}`);
      }
    } catch (error) {
      this.logger.error('Erro ao processar webhook Stripe:', error);
    }
  }

  /**
   * Processa checkout completado
   */
  private async handleCheckoutCompleted(checkoutSession: any): Promise<void> {
    try {
      const sessionId = checkoutSession.metadata?.sessionId;
      if (!sessionId) {
        this.logger.warn('Session ID não encontrado no metadata do checkout');
        return;
      }

      await this.updateSession(sessionId, {
        status: 'completed',
        current_step: 'confirmation',
        stripe_checkout_session_id: checkoutSession.id,
        completed_at: new Date().toISOString()
      });

      this.logger.log(`Sessão de upgrade completada: ${sessionId}`);
    } catch (error) {
      this.logger.error('Erro ao processar checkout completado:', error);
    }
  }

  /**
   * Processa checkout expirado
   */
  private async handleCheckoutExpired(checkoutSession: any): Promise<void> {
    try {
      const sessionId = checkoutSession.metadata?.sessionId;
      if (!sessionId) {
        this.logger.warn('Session ID não encontrado no metadata do checkout expirado');
        return;
      }

      await this.updateSession(sessionId, {
        status: 'expired',
        current_step: 'expired'
      });

      this.logger.log(`Sessão de upgrade expirada: ${sessionId}`);
    } catch (error) {
      this.logger.error('Erro ao processar checkout expirado:', error);
    }
  }

  /**
   * Processa pagamento bem-sucedido
   */
  private async handlePaymentSucceeded(invoice: any): Promise<void> {
    try {
      const sessionId = invoice.metadata?.sessionId;
      if (!sessionId) {
        this.logger.warn('Session ID não encontrado no metadata da invoice');
        return;
      }

      await this.updateSession(sessionId, {
        status: 'payment_confirmed',
        payment_confirmed_at: new Date().toISOString()
      });

      this.logger.log(`Pagamento confirmado para sessão: ${sessionId}`);
    } catch (error) {
      this.logger.error('Erro ao processar pagamento bem-sucedido:', error);
    }
  }

  /**
   * Processa pagamento falhado
   */
  private async handlePaymentFailed(invoice: any): Promise<void> {
    try {
      const sessionId = invoice.metadata?.sessionId;
      if (!sessionId) {
        this.logger.warn('Session ID não encontrado no metadata da invoice falhada');
        return;
      }

      await this.updateSession(sessionId, {
        status: 'payment_failed',
        payment_failed_at: new Date().toISOString()
      });

      this.logger.log(`Pagamento falhado para sessão: ${sessionId}`);
    } catch (error) {
      this.logger.error('Erro ao processar pagamento falhado:', error);
    }
  }

  /**
   * Gera mensagem de upgrade com Stripe Checkout
   */
  async generateUpgradeMessage(
    planName: string,
    billingCycle: 'monthly' | 'yearly',
    phoneNumber: string
  ): Promise<string> {
    try {
      // Detectar jurisdição
      const jurisdictionInfo = this.jurisdictionService.detectJurisdiction(phoneNumber);
      const jurisdiction = jurisdictionInfo.jurisdiction;

      // Buscar plano
      const plan = await this.plansService.getPlanByName(planName);
      if (!plan) {
        throw new Error(`Plano ${planName} não encontrado`);
      }

      const amount = billingCycle === 'monthly' ? plan.monthly_price : plan.yearly_price;
      const discount = billingCycle === 'yearly' && plan.yearly_price < (plan.monthly_price * 12)
        ? ` (${Math.round(((plan.monthly_price * 12 - plan.yearly_price) / (plan.monthly_price * 12)) * 100)}% de desconto)`
        : '';

      return `🚀 **Upgrade para ${planName.toUpperCase()} ${billingCycle === 'monthly' ? 'Mensal' : 'Anual'}${discount}**

💰 **Valor:** R$ ${amount.toFixed(2)}/${billingCycle === 'monthly' ? 'mês' : 'ano'}

📋 **Funcionalidades incluídas:**
${plan.features.map(feature => `• ${feature}`).join('\n')}

💳 **Pagamento seguro via Stripe**
Clique no link abaixo para finalizar seu upgrade:

*Link será gerado após confirmação*`;
    } catch (error) {
      this.logger.error('Erro ao gerar mensagem de upgrade:', error);
      return `🚀 **Upgrade para ${planName.toUpperCase()} ${billingCycle === 'monthly' ? 'Mensal' : 'Anual'}**

💰 **Valor:** R$ ${billingCycle === 'monthly' ? 'Mensal' : 'Anual'}

💳 **Pagamento seguro via Stripe**
Clique no link abaixo para finalizar seu upgrade:

*Link será gerado após confirmação*`;
    }
  }

  async getSessionSummary(session: UpgradeSession): Promise<string> {
    try {
      const plan = await this.plansService.getPlanByName(session.plan_name);
      const planDisplay = plan.name;
      
      return `📋 **Resumo da Sessão:**
• Plano: ${planDisplay}
• Frequência: ${session.billing_cycle === 'monthly' ? 'Mensal' : 'Anual'}
• Valor: R$ ${session.amount.toFixed(2)}
• Status: ${session.status}
• Tentativas: ${session.attempts_count}`;
    } catch (error) {
      this.logger.error('Erro ao gerar resumo da sessão:', error);
      return `📋 **Resumo da Sessão:**
• Plano: ${session.plan_name}
• Frequência: ${session.billing_cycle === 'monthly' ? 'Mensal' : 'Anual'}
• Valor: R$ ${session.amount.toFixed(2)}
• Status: ${session.status}
• Tentativas: ${session.attempts_count}`;
    }
  }

  async getRetryMessage(session: UpgradeSession): Promise<string> {
    const summary = await this.getSessionSummary(session);
    
    if (session.attempts_count === 1) {
      return `🔄 **Continuando upgrade para ${summary}...**\n\nTentando gerar PIX novamente...`;
    } else {
      return `🔄 **Tentativa ${session.attempts_count} para ${summary}...**\n\nGerando PIX novamente...`;
    }
  }

  async getErrorRecoveryMessage(session: UpgradeSession): Promise<string> {
    try {
      const plans = await this.plansService.getUpgradePlans();
      const planNames = plans.map(p => p.name).join('" ou "');
      
      return `❌ **Erro ao gerar PIX para ${session.plan_name} ${session.billing_cycle === 'monthly' ? 'Mensal' : 'Anual'} - R$ ${session.amount.toFixed(2)}**

💡 **O que você pode fazer:**
1. **Tentar novamente** - Digite "tente novamente"
2. **Escolher outro plano** - Digite "quero o ${planNames}"
3. **Cancelar** - Digite "cancelar"

*Seu progresso foi salvo e você pode continuar de onde parou.*`;
    } catch (error) {
      this.logger.error('Erro ao gerar mensagem de recuperação:', error);
      
      // Fallback para mensagem simples
      return `❌ **Erro ao gerar PIX para ${session.plan_name} ${session.billing_cycle === 'monthly' ? 'Mensal' : 'Anual'} - R$ ${session.amount.toFixed(2)}**

💡 **O que você pode fazer:**
1. **Tentar novamente** - Digite "tente novamente"
2. **Escolher outro plano** - Digite "quero o Pro" ou "quero o Premium"
3. **Cancelar** - Digite "cancelar"

*Seu progresso foi salvo e você pode continuar de onde parou.*`;
    }
  }
} 
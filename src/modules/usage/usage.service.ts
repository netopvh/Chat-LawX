import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { PlansService } from '../plans/plans.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { JurisdictionService } from '../jurisdiction/jurisdiction.service';
import { TeamsService } from '../teams/teams.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsageLimits, CurrentUsage, UsageSummary } from './usage.interface';

@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly plansService: PlansService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly jurisdictionService: JurisdictionService,
    private readonly teamsService: TeamsService,
    private readonly prismaService: PrismaService
  ) {}

  async checkLimits(userId: string, action: 'consultation' | 'document_analysis' | 'message', phoneNumber?: string): Promise<UsageLimits> {
    try {
      // Detectar jurisdição se phoneNumber fornecido
      let jurisdiction = 'BR'; // Default
      if (phoneNumber) {
        const jurisdictionInfo = this.jurisdictionService.detectJurisdiction(phoneNumber);
        jurisdiction = jurisdictionInfo.jurisdiction;
      }

      // Para usuários brasileiros, verificar limites via Supabase teams
      if (jurisdiction === 'BR') {
        return await this.checkBrazilianLimits(userId, action, phoneNumber);
      }

      // Para usuários PT/ES, verificar limites via assinatura local
      return await this.checkLocalLimits(userId, action, jurisdiction);
    } catch (error) {
      this.logger.error('Erro ao verificar limites:', error);
      return {
        allowed: false,
        message: 'Erro ao verificar limites',
        current: 0,
        limit: null,
        plan_name: 'Desconhecido',
        jurisdiction: 'BR',
        limit_type: action
      };
    }
  }

  /**
   * Verifica limites para usuários brasileiros via Supabase teams
   */
  private async checkBrazilianLimits(userId: string, action: 'consultation' | 'document_analysis' | 'message', phoneNumber: string): Promise<UsageLimits> {
    try {
      // Buscar dados do team no Supabase
      const teamData = await this.teamsService.getTeamByPhone(phoneNumber);
      
      if (!teamData) {
        return {
          allowed: false,
          message: 'Usuário não encontrado no sistema',
          current: 0,
          limit: null,
          plan_name: 'Desconhecido',
          jurisdiction: 'BR',
          limit_type: action
        };
      }

      // Para Brasil, apenas mensagens são controladas via teams
      if (action === 'message') {
        const current = teamData.messages_used || 0;
        const limit = teamData.messages || 0;
        const allowed = current < limit;

        return {
          allowed,
          message: allowed ? 'Limite OK' : 'Limite de mensagens excedido',
          current,
          limit,
          plan_name: teamData.name || 'Team',
          jurisdiction: 'BR',
          limit_type: 'message'
        };
      }

      // Para outras ações, permitir (não controladas no Brasil)
      return {
        allowed: true,
        message: 'Limite OK',
        current: 0,
        limit: null,
        plan_name: teamData.name || 'Team',
        jurisdiction: 'BR',
        limit_type: action
      };
    } catch (error) {
      this.logger.error('Erro ao verificar limites brasileiros:', error);
      return {
        allowed: false,
        message: 'Erro ao verificar limites',
        current: 0,
        limit: null,
        plan_name: 'Desconhecido',
        jurisdiction: 'BR',
        limit_type: action
      };
    }
  }

  /**
   * Verifica limites para usuários PT/ES via assinatura local
   */
  private async checkLocalLimits(userId: string, action: 'consultation' | 'document_analysis' | 'message', jurisdiction: string): Promise<UsageLimits> {
    try {
      // Buscar assinatura ativa via Prisma (local)
      const subscription = await this.prismaService.findUserSubscription(userId);
      if (!subscription) {
        return {
          allowed: false,
          message: 'Assinatura ativa não encontrada',
          current: 0,
          limit: 0,
          plan_name: 'Desconhecido',
          jurisdiction,
          limit_type: action
        };
      }

      const plan = subscription.plan;
      // Obter/garantir usageTracking do período atual da assinatura
      const usageTracking = await this.prismaService.findOrCreateUsageTracking(
        userId,
        subscription.id,
        subscription.currentPeriodStart,
        subscription.currentPeriodEnd,
        jurisdiction
      );

      let current = 0;
      let limit: number | null = null;
      let label = '';

      switch (action) {
        case 'consultation':
          current = usageTracking.consultationsCount || 0;
          limit = plan.consultationLimit ?? null;
          label = 'consultas jurídicas';
          break;
        case 'document_analysis':
          current = usageTracking.documentAnalysisCount || 0;
          limit = plan.documentAnalysisLimit ?? null;
          label = 'análises de documentos';
          break;
        case 'message':
          current = usageTracking.messagesCount || 0;
          limit = plan.messageLimit ?? null;
          label = 'mensagens';
          break;
      }

      const allowed = limit === null || current < limit;
      if (!allowed) {
        this.logger.warn(`Limite de ${label} excedido para usuário ${userId}. Atual: ${current}, Limite: ${limit}`);
      }

      return {
        allowed,
        message: allowed ? 'Limite OK' : `Limite de ${label} excedido`,
        current,
        limit,
        plan_name: plan.name,
        jurisdiction,
        limit_type: action
      };
    } catch (error) {
      this.logger.error('Erro ao verificar limites locais (Prisma):', error);
      return {
        allowed: false,
        message: 'Erro ao verificar limites',
        current: 0,
        limit: null,
        plan_name: 'Desconhecido',
        jurisdiction,
        limit_type: action
      };
    }
  }

  private async generateUpgradeMessage(action: 'consultation' | 'document_analysis' | 'message', current: number, limit: number, jurisdiction: string = 'BR'): Promise<string> {
    const plans = await this.plansService.getPlansByJurisdiction(jurisdiction);
    const upgradePlans = plans.filter(plan => plan.name !== 'Fremium');
    
    const planOptions = upgradePlans.map(plan => {
      const discount = plan.yearly_price < (plan.monthly_price * 12) 
        ? ` (${Math.round(((plan.monthly_price * 12 - plan.yearly_price) / (plan.monthly_price * 12)) * 100)}% de desconto)`
        : '';
      
      return `${plan.name === 'Pro' ? '🟢' : '🟡'} **PLANO ${plan.name.toUpperCase()} - R$ ${plan.monthly_price.toFixed(2)}/mês**\n• ${plan.description}${discount}`;
    }).join('\n\n');

    const actionMessages = {
      consultation: `Você atingiu o limite de ${limit} consultas jurídicas do seu plano atual.`,
      document_analysis: `Você atingiu o limite de ${limit} análises de documentos do seu plano atual.`,
      message: `Você atingiu o limite de ${limit} mensagens do seu plano atual.`
    };

    return `${actionMessages[action]}

🚀 **Faça upgrade para continuar:**

${planOptions}`;
  }

  async getCurrentUsage(userId: string, subscriptionId?: string): Promise<CurrentUsage> {
    try {
      const today = new Date();
      const periodStart = new Date(today.getFullYear(), today.getMonth(), 1);
      const periodEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

      const { data, error } = await this.supabaseService.getClient()
        .from('usage_tracking')
        .select('*')
        .eq('user_id', userId)
        .eq('period_start', periodStart.toISOString().split('T')[0])
        .single();

      if (error || !data) {
        // Se não existe tracking para o período atual, criar
        return this.initializeUsageTracking(userId, subscriptionId);
      }

      return {
        consultations_count: data.consultations_count || 0,
        document_analysis_count: data.document_analysis_count || 0,
        messages_count: data.messages_count || 0,
        period_start: data.period_start,
        period_end: data.period_end,
        jurisdiction: data.jurisdiction || 'BR'
      };
    } catch (error) {
      this.logger.error('Erro ao buscar uso atual:', error);
      // Em caso de erro, tentar inicializar o tracking
      try {
        return await this.initializeUsageTracking(userId, subscriptionId);
      } catch (initError) {
        this.logger.error('Erro ao inicializar tracking após falha:', initError);
        // Retornar valores padrão se tudo falhar
        return {
          consultations_count: 0,
          document_analysis_count: 0,
          messages_count: 0,
          period_start: new Date().toISOString().split('T')[0],
          period_end: new Date().toISOString().split('T')[0],
          jurisdiction: 'BR'
        };
      }
    }
  }

  async incrementUsage(userId: string, action: 'consultation' | 'document_analysis' | 'message', phoneNumber?: string): Promise<void> {
    try {
      // Detectar jurisdição se phoneNumber fornecido
      let jurisdiction = 'BR'; // Default
      if (phoneNumber) {
        const jurisdictionInfo = this.jurisdictionService.detectJurisdiction(phoneNumber);
        jurisdiction = jurisdictionInfo.jurisdiction;
      }

      // Para usuários brasileiros, incrementar via Supabase teams
      if (jurisdiction === 'BR' && phoneNumber) {
        await this.incrementBrazilianUsage(phoneNumber, action);
        return;
      }

      // Para usuários PT/ES, incrementar via tracking local
      await this.incrementLocalUsage(userId, action, jurisdiction);
    } catch (error) {
      this.logger.error('Erro ao incrementar uso:', error);
    }
  }

  /**
   * Incrementa uso para usuários brasileiros via Supabase teams
   */
  private async incrementBrazilianUsage(phoneNumber: string, action: 'consultation' | 'document_analysis' | 'message'): Promise<void> {
    try {
      // Para Brasil, apenas mensagens são controladas via teams
      if (action === 'message') {
        await this.teamsService.incrementMessageCount(phoneNumber);
      }
      // Para outras ações, não incrementar (não controladas no Brasil)
    } catch (error) {
      this.logger.error('Erro ao incrementar uso brasileiro:', error);
    }
  }

  /**
   * Incrementa uso para usuários PT/ES via tracking local
   */
  private async incrementLocalUsage(userId: string, action: 'consultation' | 'document_analysis' | 'message', jurisdiction: string): Promise<void> {
    try {
      switch (action) {
        case 'message':
          await this.prismaService.incrementUserMessageCount(userId);
          break;
        case 'document_analysis':
          // Se houver método dedicado para documentos, usar (caso contrário incrementos já cobertos no service whatsapp)
          // Mantemos via usageService para centralização
          // Implementação dedicada opcional no futuro
          await this.prismaService.incrementUserMessageCount(userId); // placeholder nunca será chamado para 'document_analysis'
          break;
        case 'consultation':
          // Consultas podem ser incrementadas futuramente se aplicável
          break;
      }
    } catch (error) {
      this.logger.error('Erro ao incrementar uso local (Prisma):', error);
    }
  }

  async initializeUsageTracking(userId: string, subscriptionId?: string, jurisdiction: string = 'BR'): Promise<CurrentUsage> {
    try {
      const today = new Date();
      const periodStart = new Date(today.getFullYear(), today.getMonth(), 1);
      const periodEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

      // Verificar se já existe tracking para o período atual
      const { data: existingTracking } = await this.supabaseService.getClient()
        .from('usage_tracking')
        .select('*')
        .eq('user_id', userId)
        .eq('period_start', periodStart.toISOString().split('T')[0])
        .single();

      if (existingTracking) {
        // Se já existe, retornar os dados existentes
        return {
          consultations_count: existingTracking.consultations_count || 0,
          document_analysis_count: existingTracking.document_analysis_count || 0,
          messages_count: existingTracking.messages_count || 0,
          period_start: existingTracking.period_start,
          period_end: existingTracking.period_end,
          jurisdiction: existingTracking.jurisdiction || jurisdiction
        };
      }

      // Buscar assinatura ativa para obter subscription_id se não fornecido
      let finalSubscriptionId = subscriptionId;
      if (!finalSubscriptionId) {
        const subscription = await this.subscriptionsService.getActiveSubscription(userId);
        finalSubscriptionId = subscription.id;
      }

      const trackingData = {
        user_id: userId,
        subscription_id: finalSubscriptionId,
        period_start: periodStart.toISOString().split('T')[0],
        period_end: periodEnd.toISOString().split('T')[0],
        consultations_count: 0,
        document_analysis_count: 0,
        messages_count: 0,
        jurisdiction
      };

      const { data, error } = await this.supabaseService.getClient()
        .from('usage_tracking')
        .insert(trackingData)
        .select()
        .single();

      if (error) {
        this.logger.error('Erro ao inicializar tracking de uso:', error);
        throw error;
      }

      return {
        consultations_count: data.consultations_count,
        document_analysis_count: data.document_analysis_count,
        messages_count: data.messages_count,
        period_start: data.period_start,
        period_end: data.period_end,
        jurisdiction: data.jurisdiction
      };
    } catch (error) {
      this.logger.error('Erro ao inicializar tracking de uso:', error);
      throw error;
    }
  }

  async getUsageSummary(userId: string): Promise<UsageSummary> {
    try {
      // Tentar via Prisma (local PT/ES)
      const localSub = await this.prismaService.findUserSubscription(userId);
      if (localSub) {
        const usage = await this.prismaService.findOrCreateUsageTracking(
          userId,
          localSub.id,
          localSub.currentPeriodStart,
          localSub.currentPeriodEnd,
          localSub.jurisdiction || 'PT'
        );
        return {
          user_id: userId,
          plan_name: localSub.plan?.name || 'Desconhecido',
          current_usage: {
            consultations_count: usage.consultationsCount || 0,
            document_analysis_count: usage.documentAnalysisCount || 0,
            messages_count: usage.messagesCount || 0,
            period_start: localSub.currentPeriodStart.toISOString(),
            period_end: localSub.currentPeriodEnd.toISOString(),
            jurisdiction: usage.jurisdiction || (localSub.jurisdiction || 'PT')
          },
          limits: {
            consultation_limit: localSub.plan?.consultationLimit ?? null,
            document_analysis_limit: localSub.plan?.documentAnalysisLimit ?? null,
            message_limit: localSub.plan?.messageLimit ?? null,
            is_unlimited: localSub.plan?.isUnlimited ?? false,
            jurisdiction: usage.jurisdiction || (localSub.jurisdiction || 'PT')
          }
        };
      }

      // Fallback BR (Supabase)
      const subscription = await this.subscriptionsService.getActiveSubscription(userId);
      const currentUsage = await this.getCurrentUsage(userId, subscription.id);
      return {
        user_id: userId,
        plan_name: subscription.plan.name,
        current_usage: currentUsage,
        limits: {
          consultation_limit: subscription.plan.consultation_limit,
          document_analysis_limit: subscription.plan.document_analysis_limit,
          message_limit: subscription.plan.message_limit,
          is_unlimited: subscription.plan.is_unlimited,
          jurisdiction: currentUsage.jurisdiction
        }
      };
    } catch (error) {
      this.logger.error('Erro ao buscar resumo de uso (misto):', error);
      throw error;
    }
  }

  async resetMonthlyUsage(): Promise<void> {
    try {
      const today = new Date();
      const newPeriodStart = new Date(today.getFullYear(), today.getMonth(), 1);
      const newPeriodEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

      // Buscar todos os trackings ativos
      const { data: activeTrackings } = await this.supabaseService.getClient()
        .from('usage_tracking')
        .select('user_id, subscription_id');

      if (activeTrackings) {
        for (const tracking of activeTrackings) {
          // Criar novo tracking para o novo período
          await this.initializeUsageTracking(tracking.user_id, tracking.subscription_id);
        }
      }
    } catch (error) {
      this.logger.error('Erro ao resetar uso mensal:', error);
      throw error;
    }
  }
}
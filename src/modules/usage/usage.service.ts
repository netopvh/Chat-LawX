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
      // Buscar assinatura ativa do usuário
      const subscription = await this.subscriptionsService.getActiveSubscription(userId);
      const plan = subscription.plan;
      
      // Buscar uso atual do período
      const currentUsage = await this.getCurrentUsage(userId, subscription.id);
      
      let current: number;
      let limit: number | null;
      let message: string;
      
      switch (action) {
        case 'consultation':
          current = currentUsage.consultations_count;
          limit = plan.consultation_limit;
          message = 'consultas jurídicas';
          break;
        case 'document_analysis':
          current = currentUsage.document_analysis_count;
          limit = plan.document_analysis_limit;
          message = 'análises de documentos';
          break;
        case 'message':
          current = currentUsage.messages_count;
          limit = plan.message_limit;
          message = 'mensagens';
          break;
        default:
          throw new Error(`Ação não reconhecida: ${action}`);
      }
      
      const allowed = limit === null || current < limit;
      
      if (!allowed) {
        this.logger.warn(`Limite de ${message} excedido para usuário ${userId}. Atual: ${current}, Limite: ${limit}`);
      }
      
      return {
        allowed,
        message: allowed ? 'Limite OK' : `Limite de ${message} excedido`,
        current,
        limit,
        plan_name: plan.name,
        jurisdiction,
        limit_type: action
      };
    } catch (error) {
      this.logger.error('Erro ao verificar limites locais:', error);
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
      const today = new Date();
      const periodStart = new Date(today.getFullYear(), today.getMonth(), 1);

      // Verificar se já existe tracking para o período
      const { data: existingTracking } = await this.supabaseService.getClient()
        .from('usage_tracking')
        .select('*')
        .eq('user_id', userId)
        .eq('period_start', periodStart.toISOString().split('T')[0])
        .single();

      if (existingTracking) {
        // Atualizar contador existente
        const updateData: any = { 
          updated_at: new Date().toISOString(),
          jurisdiction 
        };
        
        switch (action) {
          case 'consultation':
            updateData.consultations_count = (existingTracking.consultations_count || 0) + 1;
            break;
          case 'document_analysis':
            updateData.document_analysis_count = (existingTracking.document_analysis_count || 0) + 1;
            break;
          case 'message':
            updateData.messages_count = (existingTracking.messages_count || 0) + 1;
            break;
        }

        const { error } = await this.supabaseService.getClient()
          .from('usage_tracking')
          .update(updateData)
          .eq('id', existingTracking.id);

        if (error) {
          this.logger.error('Erro ao incrementar uso local:', error);
        }
      } else {
        // Criar novo tracking primeiro
        await this.initializeUsageTracking(userId, undefined, jurisdiction);
        // Depois incrementar
        await this.incrementLocalUsage(userId, action, jurisdiction);
      }
    } catch (error) {
      this.logger.error('Erro ao incrementar uso local:', error);
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
      this.logger.error('Erro ao buscar resumo de uso:', error);
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
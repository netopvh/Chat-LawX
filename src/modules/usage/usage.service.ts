import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { PlansService } from '../plans/plans.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { UsageLimits, CurrentUsage, UsageSummary } from './usage.interface';

@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly plansService: PlansService,
    private readonly subscriptionsService: SubscriptionsService
  ) {}

  async checkLimits(userId: string, action: 'expense' | 'revenue' | 'report' | 'message'): Promise<UsageLimits> {
    try {
      // Buscar assinatura ativa do usuário
      const subscription = await this.subscriptionsService.getActiveSubscription(userId);
      const plan = subscription.plan;
      
      // Buscar uso atual
      const currentUsage = await this.getCurrentUsage(userId);
      
      // Verificar se o plano é ilimitado
      if (plan.is_unlimited) {
        return {
          allowed: true,
          message: '',
          current: 0,
          limit: null,
          plan_name: plan.name
        };
      }

      // Verificar limites baseado na ação
      switch (action) {
        case 'expense':
          if (currentUsage.expenses_count < plan.expense_limit) {
            return {
              allowed: true,
              message: '',
              current: currentUsage.expenses_count,
              limit: plan.expense_limit,
              plan_name: plan.name
            };
          }
          return {
            allowed: false,
            message: await this.generateUpgradeMessage('expense', currentUsage.expenses_count, plan.expense_limit),
            current: currentUsage.expenses_count,
            limit: plan.expense_limit,
            plan_name: plan.name
          };

        case 'revenue':
          const revenueLimit = (plan as any).revenue_limit;
          if (currentUsage.revenues_count < revenueLimit) {
            return {
              allowed: true,
              message: '',
              current: currentUsage.revenues_count,
              limit: revenueLimit,
              plan_name: plan.name
            };
          }
          return {
            allowed: false,
            message: await this.generateUpgradeMessage('revenue', currentUsage.revenues_count, revenueLimit),
            current: currentUsage.revenues_count,
            limit: revenueLimit,
            plan_name: plan.name
          };

        case 'report':
          if (currentUsage.reports_count < plan.report_limit) {
            return {
              allowed: true,
              message: '',
              current: currentUsage.reports_count,
              limit: plan.report_limit,
              plan_name: plan.name
            };
          }
          return {
            allowed: false,
            message: await this.generateUpgradeMessage('report', currentUsage.reports_count, plan.report_limit),
            current: currentUsage.reports_count,
            limit: plan.report_limit,
            plan_name: plan.name
          };

        case 'message':
          // Verificar se o plano tem limite de mensagens definido
          const messageLimit = plan.message_limit || 10; // Default para Fremium
          
          if (currentUsage.messages_count < messageLimit) {
            return {
              allowed: true,
              message: '',
              current: currentUsage.messages_count,
              limit: messageLimit,
              plan_name: plan.name
            };
          }
          return {
            allowed: false,
            message: await this.generateUpgradeMessage('message', currentUsage.messages_count, messageLimit),
            current: currentUsage.messages_count,
            limit: messageLimit,
            plan_name: plan.name
          };

        default:
          return {
            allowed: false,
            message: 'Ação não reconhecida',
            current: 0,
            limit: null,
            plan_name: plan.name
          };
      }
    } catch (error) {
      this.logger.error('Erro ao verificar limites:', error);
      return {
        allowed: false,
        message: 'Erro ao verificar limites',
        current: 0,
        limit: null,
        plan_name: 'Unknown'
      };
    }
  }

  private async generateUpgradeMessage(action: 'expense' | 'revenue' | 'report' | 'message', current: number, limit: number): Promise<string> {
    const plans = await this.plansService.getAllPlans();
    const upgradePlans = plans.filter(plan => plan.name !== 'Fremium');
    
    const planOptions = upgradePlans.map(plan => {
      const discount = plan.yearly_price < (plan.monthly_price * 12) 
        ? ` (${Math.round(((plan.monthly_price * 12 - plan.yearly_price) / (plan.monthly_price * 12)) * 100)}% de desconto)`
        : '';
      
      return `${plan.name === 'Pro' ? '🟢' : '🟡'} **PLANO ${plan.name.toUpperCase()} - R$ ${plan.monthly_price.toFixed(2)}/mês**\n• ${plan.description}${discount}`;
    }).join('\n\n');

    const actionMessages = {
      expense: `Você atingiu o limite de ${limit} despesas do seu plano atual.`,
      revenue: `Você atingiu o limite de ${limit} receitas do seu plano atual.`,
      report: `Você atingiu o limite de ${limit} relatórios do seu plano atual.`,
      message: `Você atingiu o limite de ${limit} mensagens do seu plano atual.`
    };

    return `${actionMessages[action]}

🚀 **Faça upgrade para continuar:**

${planOptions}`;
  }

  async getCurrentUsage(userId: string): Promise<CurrentUsage> {
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
        return this.initializeUsageTracking(userId);
      }

      return {
        expenses_count: data.expenses_count || 0,
        revenues_count: data.revenues_count || 0, // Adicionado revenues_count
        reports_count: data.reports_count || 0,
        messages_count: data.messages_count || 0,
        period_start: data.period_start,
        period_end: data.period_end
      };
    } catch (error) {
      this.logger.error('Erro ao buscar uso atual:', error);
      // Em caso de erro, tentar inicializar o tracking
      try {
        return await this.initializeUsageTracking(userId);
      } catch (initError) {
        this.logger.error('Erro ao inicializar tracking após falha:', initError);
        // Retornar valores padrão se tudo falhar
        return {
          expenses_count: 0,
          revenues_count: 0, // Adicionado revenues_count
          reports_count: 0,
          messages_count: 0,
          period_start: new Date().toISOString().split('T')[0],
          period_end: new Date().toISOString().split('T')[0]
        };
      }
    }
  }

  async incrementUsage(userId: string, action: 'expense' | 'report' | 'message'): Promise<void> {
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
        const updateData: any = { updated_at: new Date().toISOString() };
        
        switch (action) {
          case 'expense':
            updateData.expenses_count = (existingTracking.expenses_count || 0) + 1;
            break;
          case 'report':
            updateData.reports_count = (existingTracking.reports_count || 0) + 1;
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
          this.logger.error('Erro ao incrementar uso:', error);
        }
      } else {
        // Criar novo tracking primeiro
        await this.initializeUsageTracking(userId);
        // Depois incrementar
        await this.incrementUsage(userId, action);
      }
    } catch (error) {
      this.logger.error('Erro ao incrementar uso:', error);
    }
  }

  async incrementRevenueCount(userId: string): Promise<void> {
    try {
      const today = new Date();
      const periodStart = new Date(today.getFullYear(), today.getMonth(), 1);
      const periodEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      
      // Verificar se já existe tracking para este período
      const { data: existingTracking } = await this.supabaseService.getClient()
        .from('usage_tracking')
        .select('*')
        .eq('user_id', userId)
        .gte('period_start', periodStart.toISOString().split('T')[0])
        .lte('period_end', periodEnd.toISOString().split('T')[0])
        .single();

      if (existingTracking) {
        // Atualizar contador existente
        const { error } = await this.supabaseService.getClient()
          .from('usage_tracking')
          .update({
            revenues_count: (existingTracking.revenues_count || 0) + 1,
            updated_at: new Date().toISOString()
          })
          .eq('id', existingTracking.id);

        if (error) {
          this.logger.error('Erro ao incrementar contador de receitas:', error);
          throw new Error('Erro ao atualizar contador de receitas');
        }
      } else {
        // Criar novo registro de tracking
        const { error } = await this.supabaseService.getClient()
          .from('usage_tracking')
          .insert({
            user_id: userId,
            subscription_id: (await this.subscriptionsService.getActiveSubscription(userId)).id,
            period_start: periodStart.toISOString().split('T')[0],
            period_end: periodEnd.toISOString().split('T')[0],
            expenses_count: 0,
            revenues_count: 1,
            reports_count: 0,
            messages_count: 0
          });

        if (error) {
          this.logger.error('Erro ao criar tracking de receitas:', error);
          throw new Error('Erro ao criar tracking de receitas');
        }
      }

      this.logger.log(`✅ Contador de receitas incrementado para usuário ${userId}`);
    } catch (error) {
      this.logger.error('Erro ao incrementar contador de receitas:', error);
      throw error;
    }
  }

  async initializeUsageTracking(userId: string): Promise<CurrentUsage> {
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
          expenses_count: existingTracking.expenses_count || 0,
          revenues_count: existingTracking.revenues_count || 0, // Adicionado revenues_count
          reports_count: existingTracking.reports_count || 0,
          messages_count: existingTracking.messages_count || 0,
          period_start: existingTracking.period_start,
          period_end: existingTracking.period_end
        };
      }

      // Buscar assinatura ativa para obter subscription_id
      const subscription = await this.subscriptionsService.getActiveSubscription(userId);

      const trackingData = {
        user_id: userId,
        subscription_id: subscription.id,
        period_start: periodStart.toISOString().split('T')[0],
        period_end: periodEnd.toISOString().split('T')[0],
        expenses_count: 0,
        revenues_count: 0, // Adicionado revenues_count
        reports_count: 0,
        messages_count: 0
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
        expenses_count: data.expenses_count,
        revenues_count: data.revenues_count, // Adicionado revenues_count
        reports_count: data.reports_count,
        messages_count: data.messages_count,
        period_start: data.period_start,
        period_end: data.period_end
      };
    } catch (error) {
      this.logger.error('Erro ao inicializar tracking de uso:', error);
      throw error;
    }
  }

  async getUsageSummary(userId: string): Promise<UsageSummary> {
    try {
      const subscription = await this.subscriptionsService.getActiveSubscription(userId);
      const currentUsage = await this.getCurrentUsage(userId);

      return {
        user_id: userId,
        plan_name: subscription.plan.name,
        current_usage: currentUsage,
        limits: {
          expense_limit: subscription.plan.expense_limit,
          revenue_limit: (subscription.plan as any).revenue_limit, // Adicionado revenue_limit
          report_limit: subscription.plan.report_limit,
          message_limit: subscription.plan.message_limit,
          is_unlimited: subscription.plan.is_unlimited
        }
      };
    } catch (error) {
      this.logger.error('Erro ao buscar resumo de uso:', error);
      throw error;
    }
  }

  async resetMonthlyUsage(): Promise<void> {
    try {
      // Este método pode ser chamado por um cron job para resetar uso mensal
      const today = new Date();
      const newPeriodStart = new Date(today.getFullYear(), today.getMonth(), 1);
      const newPeriodEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

      this.logger.log('Resetando uso mensal para todos os usuários');
      
      // Buscar todos os usuários com tracking ativo
      const { data: activeTrackings } = await this.supabaseService.getClient()
        .from('usage_tracking')
        .select('user_id, subscription_id')
        .eq('period_start', newPeriodStart.toISOString().split('T')[0]);

      // Para cada usuário, criar novo tracking se não existir
      for (const tracking of activeTrackings || []) {
        const existingTracking = await this.getCurrentUsage(tracking.user_id);
        if (!existingTracking) {
          await this.initializeUsageTracking(tracking.user_id);
        }
      }
    } catch (error) {
      this.logger.error('Erro ao resetar uso mensal:', error);
    }
  }

  async getUsageStatusMessage(userId: string): Promise<string> {
    try {
      const usageSummary = await this.getUsageSummary(userId);
      const { current_usage, limits, plan_name } = usageSummary;

      if (limits.is_unlimited) {
        return `📊 **Status do Plano ${plan_name}**
✅ Uso ilimitado ativo
🎉 Você pode usar todos os recursos sem restrições!`;
      }

      const expensePercentage = Math.round((current_usage.expenses_count / limits.expense_limit) * 100);
      const revenuePercentage = Math.round((current_usage.revenues_count / limits.revenue_limit) * 100); // Adicionado revenuePercentage
      const reportPercentage = Math.round((current_usage.reports_count / limits.report_limit) * 100);
      const messagePercentage = Math.round((current_usage.messages_count / limits.message_limit) * 100);

      const getStatusEmoji = (percentage: number) => {
        if (percentage >= 90) return '🔴';
        if (percentage >= 70) return '🟡';
        return '🟢';
      };

      return `📊 **Status do Plano ${plan_name}**

${getStatusEmoji(expensePercentage)} **Despesas:** ${current_usage.expenses_count}/${limits.expense_limit} (${expensePercentage}%)
${getStatusEmoji(revenuePercentage)} **Receitas:** ${current_usage.revenues_count}/${limits.revenue_limit} (${revenuePercentage}%)
${getStatusEmoji(reportPercentage)} **Relatórios:** ${current_usage.reports_count}/${limits.report_limit} (${reportPercentage}%)
${getStatusEmoji(messagePercentage)} **Mensagens:** ${current_usage.messages_count}/${limits.message_limit} (${messagePercentage}%)

📅 Período: ${new Date(current_usage.period_start).toLocaleDateString('pt-BR')} a ${new Date(current_usage.period_end).toLocaleDateString('pt-BR')}

${expensePercentage >= 90 || reportPercentage >= 90 || messagePercentage >= 90 ? '⚠️ Você está próximo do limite! Considere fazer upgrade.' : '✅ Uso dentro dos limites normais.'}`;
    } catch (error) {
      this.logger.error('Erro ao gerar mensagem de status:', error);
      return '❌ Erro ao buscar status de uso. Tente novamente.';
    }
  }
} 
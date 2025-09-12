import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { Subscription, CreateSubscriptionDto, UpdateSubscriptionDto, SubscriptionWithPlan } from './subscriptions.interface';

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  async createSubscription(createSubscriptionDto: CreateSubscriptionDto): Promise<Subscription> {
    try {
      // Calcular período da assinatura
      const now = new Date();
      const periodStart = now.toISOString();
      
      let periodEnd: Date;
      if (createSubscriptionDto.billing_cycle === 'monthly') {
        periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
      } else {
        periodEnd = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
      }

      const subscriptionData = {
        ...createSubscriptionDto,
        current_period_start: periodStart,
        current_period_end: periodEnd.toISOString(),
        status: createSubscriptionDto.status || 'active'
      };

      const { data, error } = await this.supabaseService.getClient()
        .from('subscriptions')
        .insert(subscriptionData)
        .select()
        .single();

      if (error) {
        this.logger.error('Erro ao criar assinatura:', error);
        throw new Error('Erro ao criar assinatura');
      }

      this.logger.log(`Assinatura criada para usuário ${createSubscriptionDto.user_id}`);
      return data;
    } catch (error) {
      this.logger.error('Erro no serviço de assinaturas:', error);
      throw error;
    }
  }

  async getActiveSubscription(userId: string): Promise<SubscriptionWithPlan> {
    try {
      const { data, error } = await this.supabaseService.getClient()
        .from('subscriptions')
        .select(`
          *,
          plan:plans(*)
        `)
        .eq('user_id', userId)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (error) {
        this.logger.error('Erro ao buscar assinatura ativa:', error);
        throw new Error('Assinatura ativa não encontrada');
      }

      return data;
    } catch (error) {
      this.logger.error('Erro no serviço de assinaturas:', error);
      throw error;
    }
  }

  async getSubscriptionById(id: string): Promise<SubscriptionWithPlan> {
    try {
      const { data, error } = await this.supabaseService.getClient()
        .from('subscriptions')
        .select(`
          *,
          plan:plans(*)
        `)
        .eq('id', id)
        .single();

      if (error) {
        this.logger.error('Erro ao buscar assinatura por ID:', error);
        throw new Error('Assinatura não encontrada');
      }

      return data;
    } catch (error) {
      this.logger.error('Erro no serviço de assinaturas:', error);
      throw error;
    }
  }

  async updateSubscription(id: string, updateSubscriptionDto: UpdateSubscriptionDto): Promise<Subscription> {
    try {
      const { data, error } = await this.supabaseService.getClient()
        .from('subscriptions')
        .update({ ...updateSubscriptionDto, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();

      if (error) {
        this.logger.error('Erro ao atualizar assinatura:', error);
        throw new Error('Erro ao atualizar assinatura');
      }

      this.logger.log(`Assinatura ${id} atualizada com sucesso`);
      return data;
    } catch (error) {
      this.logger.error('Erro no serviço de assinaturas:', error);
      throw error;
    }
  }

  async cancelSubscription(id: string): Promise<Subscription> {
    try {
      const { data, error } = await this.supabaseService.getClient()
        .from('subscriptions')
        .update({ 
          status: 'cancelled',
          cancelled_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .select()
        .single();

      if (error) {
        this.logger.error('Erro ao cancelar assinatura:', error);
        throw new Error('Erro ao cancelar assinatura');
      }

      this.logger.log(`Assinatura ${id} cancelada com sucesso`);
      return data;
    } catch (error) {
      this.logger.error('Erro no serviço de assinaturas:', error);
      throw error;
    }
  }

  async getUserSubscriptions(userId: string): Promise<SubscriptionWithPlan[]> {
    try {
      const { data, error } = await this.supabaseService.getClient()
        .from('subscriptions')
        .select(`
          *,
          plan:plans(*)
        `)
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error) {
        this.logger.error('Erro ao buscar assinaturas do usuário:', error);
        throw new Error('Erro ao buscar assinaturas');
      }

      return data || [];
    } catch (error) {
      this.logger.error('Erro no serviço de assinaturas:', error);
      throw error;
    }
  }

  async checkSubscriptionExpiration(): Promise<void> {
    try {
      const now = new Date();
      
      // Buscar assinaturas expiradas
      const { data: expiredSubscriptions, error } = await this.supabaseService.getClient()
        .from('subscriptions')
        .select('*')
        .eq('status', 'active')
        .lt('current_period_end', now.toISOString());

      if (error) {
        this.logger.error('Erro ao verificar assinaturas expiradas:', error);
        return;
      }

      // Marcar como expiradas
      for (const subscription of expiredSubscriptions || []) {
        await this.updateSubscription(subscription.id, { status: 'expired' });
        this.logger.log(`Assinatura ${subscription.id} marcada como expirada`);
      }
    } catch (error) {
      this.logger.error('Erro ao verificar expiração de assinaturas:', error);
    }
  }

  async createFremiumSubscription(userId: string): Promise<Subscription> {
    try {
      // Buscar plano Fremium
      const { data: fremiumPlan, error: planError } = await this.supabaseService.getClient()
        .from('plans')
        .select('*')
        .eq('name', 'Fremium')
        .single();

      if (planError) {
        this.logger.error('Erro ao buscar plano Fremium:', planError);
        throw new Error('Plano Fremium não encontrado');
      }

      return this.createSubscription({
        user_id: userId,
        plan_id: fremiumPlan.id,
        billing_cycle: 'monthly',
        status: 'active'
      });
    } catch (error) {
      this.logger.error('Erro ao criar assinatura Fremium:', error);
      throw error;
    }
  }
} 
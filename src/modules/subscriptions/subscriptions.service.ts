import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { StripeService } from '../stripe/stripe.service';
import { JurisdictionService } from '../jurisdiction/jurisdiction.service';
import { Subscription, CreateSubscriptionDto, UpdateSubscriptionDto, SubscriptionWithPlan } from './subscriptions.interface';

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly stripeService: StripeService,
    private readonly jurisdictionService: JurisdictionService,
  ) {}

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
      this.logger.log(`🎁 Criando assinatura Fremium para usuário: ${userId}`);
      
      // Buscar plano Fremium
      const { data: fremiumPlan, error: planError } = await this.supabaseService.getClient()
        .from('plans')
        .select('*')
        .eq('name', 'Fremium')
        .eq('is_active', true)
        .single();

      if (planError || !fremiumPlan) {
        this.logger.error('Erro ao buscar plano Fremium:', planError);
        
        // Se não existe, criar o plano Fremium automaticamente
        const newFremiumPlan = await this.createFremiumPlan();
        return this.createSubscription({
          user_id: userId,
          plan_id: newFremiumPlan.id,
          billing_cycle: 'monthly',
          status: 'active',
          jurisdiction: 'PT' // Default para PT/ES
        });
      }

      const subscription = await this.createSubscription({
        user_id: userId,
        plan_id: fremiumPlan.id,
        billing_cycle: 'monthly',
        status: 'active',
        jurisdiction: fremiumPlan.jurisdiction
      });

      this.logger.log(`✅ Assinatura Fremium criada com sucesso para usuário: ${userId}`);
      return subscription;
    } catch (error) {
      this.logger.error('Erro ao criar assinatura Fremium:', error);
      throw error;
    }
  }

  /**
   * Cria o plano Fremium se não existir
   */
  private async createFremiumPlan(): Promise<any> {
    try {
      this.logger.log('🔧 Criando plano Fremium automaticamente...');
      
      const fremiumPlanData = {
        name: 'Fremium',
        description: 'Plano gratuito com 2 consultas jurídicas',
        monthly_price: 0,
        yearly_price: 0,
        consultation_limit: 2,
        document_analysis_limit: 1,
        message_limit: 2,
        is_unlimited: false,
        is_active: true,
        jurisdiction: 'PT',
        ddi: '351',
        features: ['2 consultas jurídicas', '1 análise de documento', 'Suporte básico']
      };

      const { data, error } = await this.supabaseService.getClient()
        .from('plans')
        .insert(fremiumPlanData)
        .select()
        .single();

      if (error) {
        this.logger.error('Erro ao criar plano Fremium:', error);
        throw new Error('Erro ao criar plano Fremium');
      }

      this.logger.log('✅ Plano Fremium criado com sucesso');
      return data;
    } catch (error) {
      this.logger.error('Erro ao criar plano Fremium:', error);
      throw error;
    }
  }

  // ===== NOVOS MÉTODOS PARA CHAT LAWX =====

  /**
   * Cria assinatura com integração Stripe
   */
  async createStripeSubscription(
    userId: string,
    planId: string,
    billingCycle: 'monthly' | 'yearly',
    stripeCustomerId: string
  ): Promise<Subscription> {
    try {
      // Buscar plano para obter informações do Stripe
      const { data: plan, error: planError } = await this.supabaseService.getClient()
        .from('plans')
        .select('*')
        .eq('id', planId)
        .single();

      if (planError) {
        this.logger.error('Erro ao buscar plano:', planError);
        throw new Error('Plano não encontrado');
      }

      // Criar assinatura no Stripe
      const stripePriceId = billingCycle === 'monthly' 
        ? plan.stripe_price_id_monthly 
        : plan.stripe_price_id_yearly;

      if (!stripePriceId) {
        throw new Error('Preço do Stripe não encontrado para este plano');
      }

      const stripeSubscription = await this.stripeService.createSubscription({
        customer: stripeCustomerId,
        items: [{ price: stripePriceId }],
        metadata: {
          user_id: userId,
          plan_id: planId,
          jurisdiction: plan.jurisdiction,
        },
      });

      // Criar assinatura local
      const subscriptionData = {
        user_id: userId,
        plan_id: planId,
        billing_cycle: billingCycle,
        status: 'active' as const,
        stripe_subscription_id: stripeSubscription.id,
        stripe_customer_id: stripeCustomerId,
        jurisdiction: plan.jurisdiction,
        sync_status: 'synced' as const,
        last_sync_at: new Date().toISOString(),
      };

      return await this.createSubscription(subscriptionData);
    } catch (error) {
      this.logger.error('Erro ao criar assinatura Stripe:', error);
      throw error;
    }
  }

  /**
   * Processa webhook do Stripe
   */
  async processStripeWebhook(event: any): Promise<void> {
    try {
      this.logger.log('Processando webhook do Stripe:', event.type);

      switch (event.type) {
        case 'customer.subscription.created':
          await this.handleSubscriptionCreated(event.data.object);
          break;
        case 'customer.subscription.updated':
          await this.handleSubscriptionUpdated(event.data.object);
          break;
        case 'customer.subscription.deleted':
          await this.handleSubscriptionDeleted(event.data.object);
          break;
        case 'invoice.payment_succeeded':
          await this.handlePaymentSucceeded(event.data.object);
          break;
        case 'invoice.payment_failed':
          await this.handlePaymentFailed(event.data.object);
          break;
        default:
          this.logger.log('Evento do Stripe não processado:', event.type);
      }
    } catch (error) {
      this.logger.error('Erro ao processar webhook do Stripe:', error);
      throw error;
    }
  }

  private async handleSubscriptionCreated(stripeSubscription: any): Promise<void> {
    try {
      const userId = stripeSubscription.metadata?.user_id;
      const planId = stripeSubscription.metadata?.plan_id;

      if (!userId || !planId) {
        this.logger.warn('Assinatura Stripe sem metadata necessária:', stripeSubscription.id);
        return;
      }

      // Verificar se assinatura já existe
      const existingSubscription = await this.getSubscriptionByStripeId(stripeSubscription.id);
      if (existingSubscription) {
        this.logger.log('Assinatura já existe:', stripeSubscription.id);
        return;
      }

      // Criar assinatura local
      await this.createSubscription({
        user_id: userId,
        plan_id: planId,
        billing_cycle: stripeSubscription.items.data[0].price.recurring.interval,
        status: this.mapStripeStatus(stripeSubscription.status),
        stripe_subscription_id: stripeSubscription.id,
        stripe_customer_id: stripeSubscription.customer,
        jurisdiction: stripeSubscription.metadata?.jurisdiction,
        sync_status: 'synced',
        last_sync_at: new Date().toISOString(),
      });

      this.logger.log('Assinatura criada via webhook:', stripeSubscription.id);
    } catch (error) {
      this.logger.error('Erro ao processar criação de assinatura:', error);
    }
  }

  private async handleSubscriptionUpdated(stripeSubscription: any): Promise<void> {
    try {
      const localSubscription = await this.getSubscriptionByStripeId(stripeSubscription.id);
      if (!localSubscription) {
        this.logger.warn('Assinatura local não encontrada para atualização:', stripeSubscription.id);
        return;
      }

      await this.updateSubscription(localSubscription.id, {
        status: this.mapStripeStatus(stripeSubscription.status),
        current_period_end: new Date(stripeSubscription.current_period_end * 1000).toISOString(),
        sync_status: 'synced',
        last_sync_at: new Date().toISOString(),
      });

      this.logger.log('Assinatura atualizada via webhook:', stripeSubscription.id);
    } catch (error) {
      this.logger.error('Erro ao processar atualização de assinatura:', error);
    }
  }

  private async handleSubscriptionDeleted(stripeSubscription: any): Promise<void> {
    try {
      const localSubscription = await this.getSubscriptionByStripeId(stripeSubscription.id);
      if (!localSubscription) {
        this.logger.warn('Assinatura local não encontrada para cancelamento:', stripeSubscription.id);
        return;
      }

      await this.updateSubscription(localSubscription.id, {
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        sync_status: 'synced',
        last_sync_at: new Date().toISOString(),
      });

      this.logger.log('Assinatura cancelada via webhook:', stripeSubscription.id);
    } catch (error) {
      this.logger.error('Erro ao processar cancelamento de assinatura:', error);
    }
  }

  private async handlePaymentSucceeded(invoice: any): Promise<void> {
    try {
      const subscriptionId = invoice.subscription;
      if (!subscriptionId) return;

      const localSubscription = await this.getSubscriptionByStripeId(subscriptionId);
      if (!localSubscription) return;

      await this.updateSubscription(localSubscription.id, {
        status: 'active',
        sync_status: 'synced',
        last_sync_at: new Date().toISOString(),
      });

      this.logger.log('Pagamento processado com sucesso:', invoice.id);
    } catch (error) {
      this.logger.error('Erro ao processar pagamento bem-sucedido:', error);
    }
  }

  private async handlePaymentFailed(invoice: any): Promise<void> {
    try {
      const subscriptionId = invoice.subscription;
      if (!subscriptionId) return;

      const localSubscription = await this.getSubscriptionByStripeId(subscriptionId);
      if (!localSubscription) return;

      await this.updateSubscription(localSubscription.id, {
        status: 'past_due',
        sync_status: 'synced',
        last_sync_at: new Date().toISOString(),
      });

      this.logger.log('Pagamento falhou:', invoice.id);
    } catch (error) {
      this.logger.error('Erro ao processar falha de pagamento:', error);
    }
  }

  /**
   * Busca assinatura por ID do Stripe
   */
  private async getSubscriptionByStripeId(stripeSubscriptionId: string): Promise<Subscription | null> {
    try {
      const { data, error } = await this.supabaseService.getClient()
        .from('subscriptions')
        .select('*')
        .eq('stripe_subscription_id', stripeSubscriptionId)
        .single();

      if (error) {
        return null;
      }

      return data;
    } catch (error) {
      this.logger.error('Erro ao buscar assinatura por ID do Stripe:', error);
      return null;
    }
  }

  /**
   * Mapeia status do Stripe para status local
   */
  private mapStripeStatus(stripeStatus: string): 'active' | 'cancelled' | 'expired' | 'past_due' | 'unpaid' {
    switch (stripeStatus) {
      case 'active':
        return 'active';
      case 'canceled':
      case 'cancelled':
        return 'cancelled';
      case 'incomplete':
      case 'incomplete_expired':
        return 'expired';
      case 'past_due':
        return 'past_due';
      case 'unpaid':
        return 'unpaid';
      default:
        return 'expired';
    }
  }

  /**
   * Sincroniza assinaturas com Stripe
   */
  async syncSubscriptionsWithStripe(): Promise<void> {
    try {
      const { data: subscriptions, error } = await this.supabaseService.getClient()
        .from('subscriptions')
        .select('*')
        .eq('sync_status', 'pending')
        .not('stripe_subscription_id', 'is', null);

      if (error) {
        this.logger.error('Erro ao buscar assinaturas para sincronização:', error);
        return;
      }

      for (const subscription of subscriptions) {
        try {
          const stripeSubscription = await this.stripeService.getSubscription(subscription.stripe_subscription_id);
          
          await this.updateSubscription(subscription.id, {
            status: this.mapStripeStatus(stripeSubscription.status),
            current_period_end: new Date(stripeSubscription.current_period_end * 1000).toISOString(),
            sync_status: 'synced',
            last_sync_at: new Date().toISOString(),
          });

          this.logger.log(`Assinatura ${subscription.id} sincronizada com Stripe`);
        } catch (error) {
          this.logger.error(`Erro ao sincronizar assinatura ${subscription.id}:`, error);
          
          await this.updateSubscription(subscription.id, {
            sync_status: 'error',
            last_sync_at: new Date().toISOString(),
          });
        }
      }
    } catch (error) {
      this.logger.error('Erro na sincronização com Stripe:', error);
      throw error;
    }
  }
} 
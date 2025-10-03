import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { JurisdictionService } from '../jurisdiction/jurisdiction.service';
import { Subscription, CreateSubscriptionDto, UpdateSubscriptionDto, SubscriptionWithPlan } from './subscriptions.interface';

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly stripeService: StripeService,
    private readonly jurisdictionService: JurisdictionService,
  ) {}

  private mapPrismaSubscriptionToInterface(s: any, plan?: any): Subscription | SubscriptionWithPlan {
    const base: Subscription = {
      id: s.id,
      user_id: s.userId,
      plan_id: s.planId,
      status: s.status,
      billing_cycle: s.billingCycle,
      current_period_start: s.currentPeriodStart.toISOString(),
      current_period_end: s.currentPeriodEnd.toISOString(),
      cancelled_at: s.cancelledAt ? s.cancelledAt.toISOString() : null,
      stripe_subscription_id: s.stripeSubscriptionId ?? undefined,
      stripe_customer_id: s.stripeCustomerId ?? undefined,
      last_sync_at: s.lastSyncAt ? s.lastSyncAt.toISOString() : undefined,
      sync_status: s.syncStatus,
      stripe_webhook_events: Array.isArray(s.stripeWebhookEvents) ? s.stripeWebhookEvents : undefined,
      jurisdiction: s.jurisdiction ?? undefined,
      created_at: s.createdAt.toISOString(),
      updated_at: s.updatedAt.toISOString(),
    };

    if (plan) {
      return {
        ...(base as Subscription),
        plan: {
          id: plan.id,
          name: plan.name,
          description: plan.description,
          monthly_price: plan.monthlyPrice,
          yearly_price: plan.yearlyPrice,
          consultation_limit: plan.consultationLimit ?? null,
          document_analysis_limit: plan.documentAnalysisLimit ?? null,
          message_limit: plan.messageLimit ?? null,
          is_unlimited: plan.isUnlimited,
          jurisdiction: plan.jurisdiction,
          ddi: plan.ddi,
          stripe_product_id: plan.stripeProductId ?? undefined,
          stripe_price_id_monthly: plan.stripePriceIdMonthly ?? undefined,
          stripe_price_id_yearly: plan.stripePriceIdYearly ?? undefined,
          features: Array.isArray(plan.features) ? plan.features : [],
        },
      } as SubscriptionWithPlan;
    }

    return base;
  }

  private mapCreateDtoToPrismaData(dto: CreateSubscriptionDto): any {
    return {
      userId: dto.user_id,
      planId: dto.plan_id,
      status: dto.status || 'active',
      billingCycle: dto.billing_cycle,
      currentPeriodStart: new Date(),
      currentPeriodEnd: (() => {
        const now = new Date();
        return dto.billing_cycle === 'monthly'
          ? new Date(now.getFullYear(), now.getMonth() + 1, now.getDate())
          : new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
      })(),
      stripeSubscriptionId: dto.stripe_subscription_id,
      stripeCustomerId: dto.stripe_customer_id,
      jurisdiction: dto.jurisdiction,
      syncStatus: 'synced',
      lastSyncAt: new Date(),
    };
  }

  private mapUpdateDtoToPrismaData(dto: UpdateSubscriptionDto): any {
    const data = {
      status: dto.status,
      currentPeriodEnd: dto.current_period_end ? new Date(dto.current_period_end) : undefined,
      cancelledAt: dto.cancelled_at ? new Date(dto.cancelled_at) : undefined,
      stripeSubscriptionId: dto.stripe_subscription_id,
      stripeCustomerId: dto.stripe_customer_id,
      lastSyncAt: dto.last_sync_at ? new Date(dto.last_sync_at) : undefined,
      syncStatus: dto.sync_status,
      stripeWebhookEvents: dto.stripe_webhook_events,
    } as Record<string, any>;
    Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);
    return data;
  }

  async createSubscription(createSubscriptionDto: CreateSubscriptionDto): Promise<Subscription> {
    try {
      const dataToCreate = this.mapCreateDtoToPrismaData(createSubscriptionDto);
      const created = await (this.prismaService as any).subscription.create({ data: dataToCreate });
      this.logger.log(`Assinatura criada para usuário ${createSubscriptionDto.user_id}`);
      return this.mapPrismaSubscriptionToInterface(created);
    } catch (error) {
      this.logger.error('Erro no serviço de assinaturas:', error);
      throw error;
    }
  }

  async getActiveSubscription(userId: string): Promise<SubscriptionWithPlan> {
    try {
      const s = await (this.prismaService as any).subscription.findFirst({
        where: { userId: userId, status: 'active' },
        include: { plan: true },
        orderBy: { createdAt: 'desc' },
      });
      if (!s) {
        throw new Error('Assinatura ativa não encontrado');
      }
      return this.mapPrismaSubscriptionToInterface(s, s.plan) as SubscriptionWithPlan;
    } catch (error) {
      this.logger.error('Erro no serviço de assinaturas:', error);
      throw error;
    }
  }

  async getSubscriptionById(id: string): Promise<SubscriptionWithPlan> {
    try {
      const s = await (this.prismaService as any).subscription.findUnique({
        where: { id },
        include: { plan: true },
      });
      if (!s) {
        throw new Error('Assinatura não encontrada');
      }
      return this.mapPrismaSubscriptionToInterface(s, s.plan) as SubscriptionWithPlan;
    } catch (error) {
      this.logger.error('Erro no serviço de assinaturas:', error);
      throw error;
    }
  }

  async updateSubscription(id: string, updateSubscriptionDto: UpdateSubscriptionDto): Promise<Subscription> {
    try {
      const dataToUpdate = this.mapUpdateDtoToPrismaData(updateSubscriptionDto);
      const updated = await (this.prismaService as any).subscription.update({ where: { id }, data: dataToUpdate });
      this.logger.log(`Assinatura ${id} atualizada com sucesso`);
      return this.mapPrismaSubscriptionToInterface(updated);
    } catch (error) {
      this.logger.error('Erro no serviço de assinaturas:', error);
      throw error;
    }
  }

  async cancelSubscription(id: string): Promise<Subscription> {
    try {
      const updated = await (this.prismaService as any).subscription.update({
        where: { id },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });
      this.logger.log(`Assinatura ${id} cancelada com sucesso`);
      return this.mapPrismaSubscriptionToInterface(updated);
    } catch (error) {
      this.logger.error('Erro no serviço de assinaturas:', error);
      throw error;
    }
  }

  async getUserSubscriptions(userId: string): Promise<SubscriptionWithPlan[]> {
    try {
      const subs = await (this.prismaService as any).subscription.findMany({
        where: { userId },
        include: { plan: true },
        orderBy: { createdAt: 'desc' },
      });
      return (subs || []).map((s: any) => this.mapPrismaSubscriptionToInterface(s, s.plan) as SubscriptionWithPlan);
    } catch (error) {
      this.logger.error('Erro no serviço de assinaturas:', error);
      throw error;
    }
  }

  async checkSubscriptionExpiration(): Promise<void> {
    try {
      const now = new Date();
      const expired = await (this.prismaService as any).subscription.findMany({
        where: { status: 'active', currentPeriodEnd: { lt: now } },
        select: { id: true },
      });
      for (const s of expired || []) {
        await (this.prismaService as any).subscription.update({ where: { id: s.id }, data: { status: 'expired' } });
        this.logger.log(`Assinatura ${s.id} marcada como expirada`);
      }
    } catch (error) {
      this.logger.error('Erro ao verificar expiração de assinaturas:', error);
    }
  }

  async createFremiumSubscription(userId: string): Promise<Subscription> {
    try {
      this.logger.log(`🎁 Criando assinatura Fremium para usuário: ${userId}`);
      
      // Buscar plano Fremium no Prisma
      let fremiumPlan = await (this.prismaService as any).plan.findFirst({
        where: { name: 'Fremium', isActive: true },
      });
      if (!fremiumPlan) {
        this.logger.warn('Plano Fremium não encontrado. Criando...');
        fremiumPlan = await (this.prismaService as any).plan.create({
          data: {
            name: 'Fremium',
            description: 'Plano gratuito com 2 consultas jurídicas',
            monthlyPrice: 0,
            yearlyPrice: 0,
            consultationLimit: 2,
            documentAnalysisLimit: 1,
            messageLimit: 2,
            isUnlimited: false,
            isActive: true,
            jurisdiction: 'PT',
            ddi: '351',
            features: ['2 consultas jurídicas', '1 análise de documento', 'Suporte básico'],
          },
        });
      }

      const subscription = await this.createSubscription({
        user_id: userId,
        plan_id: fremiumPlan.id,
        billing_cycle: 'monthly',
        status: 'active',
        jurisdiction: fremiumPlan.jurisdiction,
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
  // Removido: criação via Supabase. A criação agora é feita diretamente via Prisma acima.

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
      // Buscar plano para obter informações do Stripe via Prisma
      const plan = await (this.prismaService as any).plan.findUnique({ where: { id: planId } });
      if (!plan) {
        this.logger.error('Erro ao buscar plano (Prisma): Plano não encontrado');
        throw new Error('Plano não encontrado');
      }

      // Criar assinatura no Stripe
      const stripePriceId = billingCycle === 'monthly' 
        ? plan.stripePriceIdMonthly 
        : plan.stripePriceIdYearly;

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
      const subscriptionData: CreateSubscriptionDto = {
        user_id: userId,
        plan_id: planId,
        billing_cycle: billingCycle,
        status: 'active',
        stripe_subscription_id: stripeSubscription.id,
        stripe_customer_id: stripeCustomerId,
        jurisdiction: plan.jurisdiction,
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
      const s = await (this.prismaService as any).subscription.findFirst({
        where: { stripeSubscriptionId: stripeSubscriptionId },
      });
      return s ? this.mapPrismaSubscriptionToInterface(s) : null;
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
      const subscriptions = await (this.prismaService as any).subscription.findMany({
        where: { syncStatus: 'pending', NOT: { stripeSubscriptionId: null } },
      });

      for (const subscription of subscriptions) {
        try {
          const stripeSubscription = await this.stripeService.getSubscription(subscription.stripeSubscriptionId);
          
          await (this.prismaService as any).subscription.update({
            where: { id: subscription.id },
            data: {
              status: this.mapStripeStatus(stripeSubscription.status),
              currentPeriodEnd: new Date(stripeSubscription.current_period_end * 1000),
              syncStatus: 'synced',
              lastSyncAt: new Date(),
            },
          });

          this.logger.log(`Assinatura ${subscription.id} sincronizada com Stripe`);
        } catch (error) {
          this.logger.error(`Erro ao sincronizar assinatura ${subscription.id}:`, error);
          await (this.prismaService as any).subscription.update({
            where: { id: subscription.id },
            data: { syncStatus: 'error', lastSyncAt: new Date() },
          });
        }
      }
    } catch (error) {
      this.logger.error('Erro na sincronização com Stripe:', error);
      throw error;
    }
  }
} 
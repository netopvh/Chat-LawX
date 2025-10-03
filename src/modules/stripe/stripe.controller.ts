import { Controller, Post, Body, Headers, RawBody, Logger, BadRequestException } from '@nestjs/common';
import { StripeService } from './stripe.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { PlansService } from '../plans/plans.service';
import { StripeWebhookDto } from './dto/stripe-webhook.dto';

@Controller('stripe')
export class StripeController {
  private readonly logger = new Logger(StripeController.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly plansService: PlansService,
  ) {}

  /**
   * Webhook endpoint para receber eventos do Stripe
   */
  @Post('webhook')
  async handleWebhook(
    @Headers('stripe-signature') signature: string,
    @RawBody() payload: Buffer,
  ) {
    try {
      if (!signature) {
        throw new BadRequestException('Stripe signature não fornecida');
      }

      // Verificar assinatura do webhook
      const event = this.stripeService.verifyWebhookSignature(payload.toString(), signature);
      
      this.logger.log(`Webhook recebido: ${event.type} - ${event.id}`);

      // Processar evento baseado no tipo
      switch (event.type) {
        case 'customer.created':
          await this.handleCustomerCreated(event);
          break;
        case 'customer.updated':
          await this.handleCustomerUpdated(event);
          break;
        case 'customer.subscription.created':
          await this.handleSubscriptionCreated(event);
          break;
        case 'customer.subscription.updated':
          await this.handleSubscriptionUpdated(event);
          break;
        case 'customer.subscription.deleted':
          await this.handleSubscriptionDeleted(event);
          break;
        case 'invoice.payment_succeeded':
          await this.handlePaymentSucceeded(event);
          break;
        case 'invoice.payment_failed':
          await this.handlePaymentFailed(event);
          break;
        case 'checkout.session.completed':
          await this.handleCheckoutCompleted(event);
          break;
        default:
          this.logger.log(`Evento não processado: ${event.type}`);
      }

      return { received: true };
    } catch (error) {
      this.logger.error('Erro ao processar webhook do Stripe:', error);
      throw new BadRequestException('Erro ao processar webhook');
    }
  }

  /**
   * Processa evento de cliente criado
   */
  private async handleCustomerCreated(event: any) {
    const customer = event.data.object;
    this.logger.log(`Cliente criado: ${customer.id} - ${customer.email}`);
    
    // Aqui você pode adicionar lógica para sincronizar com o banco local
    // Por exemplo, criar/atualizar registro do usuário
  }

  /**
   * Processa evento de cliente atualizado
   */
  private async handleCustomerUpdated(event: any) {
    const customer = event.data.object;
    this.logger.log(`Cliente atualizado: ${customer.id}`);
    
    // Sincronizar dados do cliente
  }

  /**
   * Processa evento de assinatura criada
   */
  private async handleSubscriptionCreated(event: any) {
    const subscription = event.data.object;
    this.logger.log(`Assinatura criada: ${subscription.id} para cliente ${subscription.customer}`);

    const phone = subscription.metadata?.phone || subscription.metadata?.phone_number;
    const jurisdiction = subscription.metadata?.jurisdiction;
    const planIdFromMeta = subscription.metadata?.planId || subscription.metadata?.plan_id;
    const planNameFromMeta = subscription.metadata?.planName || subscription.metadata?.plan_name;

    if (!phone) {
      this.logger.warn('Evento de assinatura criada sem metadata.phone; ignorando');
      return;
    }

    // Resolver usuário pelo telefone
    const user = await this.usersService.getOrCreateUser(phone, jurisdiction);
    if (!user) {
      this.logger.warn(`Usuário não encontrado/gerado para phone ${phone}`);
      return;
    }

    // Resolver plano
    let planId = planIdFromMeta as string | undefined;
    if (!planId && planNameFromMeta) {
      try {
        const plan = await this.plansService.getPlanByName(planNameFromMeta);
        planId = plan.id;
      } catch (e) {
        this.logger.warn(`Plano não encontrado por nome: ${planNameFromMeta}`);
      }
    }
    if (!planId) {
      this.logger.warn('Sem planId/planName na metadata; não é possível atualizar assinatura');
      return;
    }

    // Tentar atualizar assinatura ativa; se não existir, criar uma
    try {
      const active = await this.subscriptionsService.getActiveSubscription(user.id);
      await this.subscriptionsService.updateSubscription(active.id, {
        plan_id: planId,
        stripe_subscription_id: subscription.id,
        status: 'active',
      });
    } catch (e) {
      // Sem assinatura ativa: criar localmente
      await this.subscriptionsService.createSubscription({
        user_id: user.id,
        plan_id: planId,
        billing_cycle: subscription.items?.data?.[0]?.price?.recurring?.interval === 'year' ? 'yearly' : 'monthly',
        status: 'active',
        stripe_subscription_id: subscription.id,
        stripe_customer_id: subscription.customer as string,
        jurisdiction: jurisdiction,
      });
    }
  }

  /**
   * Processa evento de assinatura atualizada
   */
  private async handleSubscriptionUpdated(event: any) {
    const subscription = event.data.object;
    this.logger.log(`Assinatura atualizada: ${subscription.id} - Status: ${subscription.status}`);
    const local = await (this.prisma as any).subscription.findFirst({ where: { stripeSubscriptionId: subscription.id } });
    if (!local) return;
    await this.subscriptionsService.updateSubscription(local.id, {
      status: subscription.status === 'active' ? 'active' : (subscription.status === 'past_due' ? 'past_due' : local.status),
      current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
      sync_status: 'synced',
      last_sync_at: new Date().toISOString(),
    });
  }

  /**
   * Processa evento de assinatura cancelada
   */
  private async handleSubscriptionDeleted(event: any) {
    const subscription = event.data.object;
    this.logger.log(`Assinatura cancelada: ${subscription.id}`);
    const local = await (this.prisma as any).subscription.findFirst({ where: { stripeSubscriptionId: subscription.id } });
    if (!local) return;
    await this.subscriptionsService.updateSubscription(local.id, {
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      last_sync_at: new Date().toISOString(),
      sync_status: 'synced',
    });
  }

  /**
   * Processa evento de pagamento bem-sucedido
   */
  private async handlePaymentSucceeded(event: any) {
    const invoice = event.data.object;
    this.logger.log(`Pagamento bem-sucedido: ${invoice.id} - ${invoice.amount_paid} ${invoice.currency}`);
    
    // Renovar assinatura ou ativar serviços
  }

  /**
   * Processa evento de pagamento falhado
   */
  private async handlePaymentFailed(event: any) {
    const invoice = event.data.object;
    this.logger.log(`Pagamento falhado: ${invoice.id} para cliente ${invoice.customer}`);
    
    // Notificar falha de pagamento
  }

  /**
   * Processa evento de checkout completado
   */
  private async handleCheckoutCompleted(event: any) {
    const session = event.data.object;
    this.logger.log(`Checkout completado: ${session.id} para cliente ${session.customer}`);

    const phone = session.metadata?.phone || session.metadata?.phone_number;
    const jurisdiction = session.metadata?.jurisdiction;
    const planId = session.metadata?.planId || session.metadata?.plan_id;
    const planName = session.metadata?.planName || session.metadata?.plan_name;
    const billingCycle = session.metadata?.billingCycle || (session.mode === 'subscription' ? (session.subscription_details?.interval || 'monthly') : 'monthly');
    const stripeSubscriptionId = session.subscription as string | undefined;
    const stripeCustomerId = session.customer as string | undefined;

    if (!phone) {
      this.logger.warn('Checkout session sem metadata.phone; ignorando');
      return;
    }

    // Resolver usuário pelo telefone
    const user = await this.usersService.getOrCreateUser(phone, jurisdiction);
    if (!user) {
      this.logger.warn(`Usuário não encontrado/gerado para phone ${phone}`);
      return;
    }

    // Resolver plano
    let resolvedPlanId = planId as string | undefined;
    if (!resolvedPlanId && planName) {
      try {
        const plan = await this.plansService.getPlanByName(planName);
        resolvedPlanId = plan.id;
      } catch (e) {
        this.logger.warn(`Plano não encontrado por nome: ${planName}`);
      }
    }
    if (!resolvedPlanId) {
      this.logger.warn('Sem planId/planName na metadata; não é possível atualizar assinatura');
      return;
    }

    // Atualizar assinatura ativa ou criar se não existir
    try {
      const active = await this.subscriptionsService.getActiveSubscription(user.id);
      await this.subscriptionsService.updateSubscription(active.id, {
        plan_id: resolvedPlanId,
        stripe_subscription_id: stripeSubscriptionId,
        stripe_customer_id: stripeCustomerId,
        status: 'active',
      });
    } catch (e) {
      await this.subscriptionsService.createSubscription({
        user_id: user.id,
        plan_id: resolvedPlanId,
        billing_cycle: billingCycle === 'year' ? 'yearly' : (billingCycle || 'monthly'),
        status: 'active',
        stripe_subscription_id: stripeSubscriptionId,
        stripe_customer_id: stripeCustomerId,
        jurisdiction: jurisdiction,
      });
    }
  }
}

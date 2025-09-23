import { Controller, Post, Body, Headers, RawBody, Logger, BadRequestException } from '@nestjs/common';
import { StripeService } from './stripe.service';
import { PrismaService } from '../prisma/prisma.service';
import { StripeWebhookDto } from './dto/stripe-webhook.dto';

@Controller('stripe')
export class StripeController {
  private readonly logger = new Logger(StripeController.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly prisma: PrismaService,
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
    
    // Ativar assinatura no sistema local (Prisma)
    const userId = subscription.metadata?.userId || subscription.metadata?.user_id;
    const planName = subscription.metadata?.planName || subscription.metadata?.plan_name;
    const jurisdiction = subscription.metadata?.jurisdiction || 'PT';

    if (!userId || !planName) {
      this.logger.warn('Webhook sem metadata userId/planName; ignorando criação local');
      return;
    }

    const plan = await (this.prisma as any).plan.findFirst({ where: { name: planName, isActive: true } });
    if (!plan) {
      this.logger.warn(`Plano não encontrado no Prisma: ${planName}`);
      return;
    }

    // Cancelar assinatura ativa anterior (se houver)
    const prev = await this.prisma.findUserSubscription(userId);
    if (prev) {
      await (this.prisma as any).subscription.update({ where: { id: prev.id }, data: { status: 'cancelled', cancelledAt: new Date() } });
    }

    // Criar nova assinatura ativa
    const now = new Date();
    const periodEnd = new Date(now);
    if (subscription.items?.data?.[0]?.price?.recurring?.interval === 'year') {
      periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    } else {
      periodEnd.setMonth(periodEnd.getMonth() + 1);
    }

    const created = await (this.prisma as any).subscription.create({
      data: {
        userId,
        planId: plan.id,
        status: 'active',
        billingCycle: subscription.items?.data?.[0]?.price?.recurring?.interval === 'year' ? 'yearly' : 'monthly',
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        stripeSubscriptionId: subscription.id,
        stripeCustomerId: subscription.customer as string,
        jurisdiction,
        syncStatus: 'synced',
      }
    });

    // Inicializar usage tracking
    await this.prisma.findOrCreateUsageTracking(userId, created.id, now, periodEnd, jurisdiction);
  }

  /**
   * Processa evento de assinatura atualizada
   */
  private async handleSubscriptionUpdated(event: any) {
    const subscription = event.data.object;
    this.logger.log(`Assinatura atualizada: ${subscription.id} - Status: ${subscription.status}`);
    
    const local = await (this.prisma as any).subscription.findFirst({ where: { stripeSubscriptionId: subscription.id } });
    if (!local) return;
    await (this.prisma as any).subscription.update({
      where: { id: local.id },
      data: {
        status: subscription.status === 'active' ? 'active' : (subscription.status === 'past_due' ? 'past_due' : local.status),
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        syncStatus: 'synced',
        updatedAt: new Date(),
      }
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
    await (this.prisma as any).subscription.update({
      where: { id: local.id },
      data: { status: 'cancelled', cancelledAt: new Date(), updatedAt: new Date() }
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
    
    // Nada aqui: a criação/ativação final é confirmada pelos eventos de subscription/invoice
  }
}

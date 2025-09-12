import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import {
  StripeCustomer,
  StripeProduct,
  StripePrice,
  StripeSubscription,
  StripeCheckoutSession,
  CreateCustomerDto,
  CreateCheckoutSessionDto,
  CreateProductDto,
  CreatePriceDto,
} from './interfaces/stripe.interface';

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private stripe: Stripe;

  constructor(private configService: ConfigService) {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (!secretKey) {
      throw new Error('STRIPE_SECRET_KEY não configurada');
    }

    this.stripe = new Stripe(secretKey, {
      apiVersion: '2023-10-16',
    });
  }

  // Customer Management
  async createCustomer(data: CreateCustomerDto): Promise<StripeCustomer> {
    try {
      const customer = await this.stripe.customers.create({
        email: data.email,
        name: data.name,
        phone: data.phone,
        metadata: data.metadata,
      });

      this.logger.log(`Cliente criado: ${customer.id}`);
      return customer as StripeCustomer;
    } catch (error) {
      this.logger.error('Erro ao criar cliente:', error);
      throw error;
    }
  }

  async getCustomer(customerId: string): Promise<StripeCustomer> {
    try {
      const customer = await this.stripe.customers.retrieve(customerId);
      return customer as StripeCustomer;
    } catch (error) {
      this.logger.error(`Erro ao buscar cliente ${customerId}:`, error);
      throw error;
    }
  }

  // Product Management
  async createProduct(data: CreateProductDto): Promise<StripeProduct> {
    try {
      const product = await this.stripe.products.create({
        name: data.name,
        description: data.description,
        metadata: data.metadata,
      });

      this.logger.log(`Produto criado: ${product.id}`);
      return product as StripeProduct;
    } catch (error) {
      this.logger.error('Erro ao criar produto:', error);
      throw error;
    }
  }

  // Price Management
  async createPrice(data: CreatePriceDto): Promise<StripePrice> {
    try {
      const price = await this.stripe.prices.create({
        product: data.productId,
        unit_amount: data.unitAmount,
        currency: data.currency,
        recurring: data.recurring,
        metadata: data.metadata,
      });

      this.logger.log(`Preço criado: ${price.id}`);
      return price as StripePrice;
    } catch (error) {
      this.logger.error('Erro ao criar preço:', error);
      throw error;
    }
  }

  // Checkout Sessions
  async createCheckoutSession(data: CreateCheckoutSessionDto): Promise<StripeCheckoutSession> {
    try {
      const session = await this.stripe.checkout.sessions.create({
        customer: data.customerId,
        customer_email: data.customerEmail,
        payment_method_types: ['card'],
        line_items: [
          {
            price: data.priceId,
            quantity: 1,
          },
        ],
        mode: 'subscription',
        success_url: data.successUrl,
        cancel_url: data.cancelUrl,
        metadata: data.metadata,
      });

      this.logger.log(`Sessão de checkout criada: ${session.id}`);
      return session as StripeCheckoutSession;
    } catch (error) {
      this.logger.error('Erro ao criar sessão de checkout:', error);
      throw error;
    }
  }

  // Subscription Management
  async getSubscription(subscriptionId: string): Promise<StripeSubscription> {
    try {
      const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
      return subscription as StripeSubscription;
    } catch (error) {
      this.logger.error(`Erro ao buscar assinatura ${subscriptionId}:`, error);
      throw error;
    }
  }

  async cancelSubscription(subscriptionId: string): Promise<StripeSubscription> {
    try {
      const subscription = await this.stripe.subscriptions.cancel(subscriptionId);
      this.logger.log(`Assinatura cancelada: ${subscriptionId}`);
      return subscription as StripeSubscription;
    } catch (error) {
      this.logger.error(`Erro ao cancelar assinatura ${subscriptionId}:`, error);
      throw error;
    }
  }

  // Webhook Verification
  verifyWebhookSignature(payload: string, signature: string): Stripe.Event {
    const webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!webhookSecret) {
      throw new Error('STRIPE_WEBHOOK_SECRET não configurada');
    }

    try {
      return this.stripe.webhooks.constructEvent(payload, signature, webhookSecret);
    } catch (error) {
      this.logger.error('Erro ao verificar webhook:', error);
      throw error;
    }
  }

  // ===== MÉTODOS ESPECÍFICOS PARA CHAT LAWX =====

  /**
   * Cria sessão de checkout simplificada (método usado pelo UpgradeSessionsService)
   */
  async createCheckoutSession(data: {
    priceId: string;
    customerEmail?: string;
    metadata?: Record<string, string>;
  }): Promise<string> {
    try {
      const session = await this.stripe.checkout.sessions.create({
        customer_email: data.customerEmail,
        payment_method_types: ['card'],
        line_items: [
          {
            price: data.priceId,
            quantity: 1,
          },
        ],
        mode: 'subscription',
        success_url: `${this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000'}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000'}/cancel`,
        metadata: data.metadata,
      });

      this.logger.log(`Sessão de checkout criada: ${session.id}`);
      return session.url || '';
    } catch (error) {
      this.logger.error('Erro ao criar sessão de checkout:', error);
      throw error;
    }
  }

  /**
   * Busca sessão de checkout por ID
   */
  async getCheckoutSession(sessionId: string): Promise<StripeCheckoutSession> {
    try {
      const session = await this.stripe.checkout.sessions.retrieve(sessionId);
      return session as StripeCheckoutSession;
    } catch (error) {
      this.logger.error(`Erro ao buscar sessão de checkout ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Lista produtos ativos
   */
  async listActiveProducts(): Promise<StripeProduct[]> {
    try {
      const products = await this.stripe.products.list({
        active: true,
        limit: 100,
      });

      return products.data as StripeProduct[];
    } catch (error) {
      this.logger.error('Erro ao listar produtos ativos:', error);
      throw error;
    }
  }

  /**
   * Lista preços de um produto
   */
  async listProductPrices(productId: string): Promise<StripePrice[]> {
    try {
      const prices = await this.stripe.prices.list({
        product: productId,
        active: true,
        limit: 100,
      });

      return prices.data as StripePrice[];
    } catch (error) {
      this.logger.error(`Erro ao listar preços do produto ${productId}:`, error);
      throw error;
    }
  }

  /**
   * Atualiza cliente
   */
  async updateCustomer(customerId: string, data: Partial<CreateCustomerDto>): Promise<StripeCustomer> {
    try {
      const customer = await this.stripe.customers.update(customerId, data);
      this.logger.log(`Cliente atualizado: ${customerId}`);
      return customer as StripeCustomer;
    } catch (error) {
      this.logger.error(`Erro ao atualizar cliente ${customerId}:`, error);
      throw error;
    }
  }
}

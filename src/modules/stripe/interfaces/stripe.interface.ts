export interface StripeCustomer {
  id: string;
  email?: string;
  name?: string;
  phone?: string;
  metadata?: Record<string, string>;
}

export interface StripeProduct {
  id: string;
  name: string;
  description?: string;
  active: boolean;
  metadata?: Record<string, string>;
}

export interface StripePrice {
  id: string;
  product: string;
  unit_amount: number;
  currency: string;
  recurring?: {
    interval: 'month' | 'year';
    interval_count: number;
  };
  active: boolean;
  metadata?: Record<string, string>;
}

export interface StripeSubscription {
  id: string;
  customer: string;
  status: 'active' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'past_due' | 'trialing' | 'unpaid';
  current_period_start: number;
  current_period_end: number;
  items: {
    data: Array<{
      id: string;
      price: StripePrice;
      quantity: number;
    }>;
  };
  metadata?: Record<string, string>;
}

export interface StripeCheckoutSession {
  id: string;
  customer?: string;
  customer_email?: string;
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  status: 'complete' | 'expired' | 'open';
  url?: string;
  metadata?: Record<string, string>;
}

export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: {
    object: any;
  };
  created: number;
  livemode: boolean;
}

export interface CreateCustomerDto {
  email?: string;
  name?: string;
  phone?: string;
  metadata?: Record<string, string>;
}

export interface CreateCheckoutSessionDto {
  customerId?: string;
  customerEmail?: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
}

export interface CreateProductDto {
  name: string;
  description?: string;
  metadata?: Record<string, string>;
}

export interface CreatePriceDto {
  productId: string;
  unitAmount: number;
  currency: string;
  recurring?: {
    interval: 'month' | 'year';
    intervalCount: number;
  };
  metadata?: Record<string, string>;
}

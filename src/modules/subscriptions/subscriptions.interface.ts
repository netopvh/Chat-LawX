export interface Subscription {
  id: string;
  user_id: string;
  plan_id: string;
  status: 'active' | 'cancelled' | 'expired' | 'past_due' | 'unpaid';
  billing_cycle: 'monthly' | 'yearly';
  current_period_start: string;
  current_period_end: string;
  cancelled_at: string | null;
  stripe_subscription_id?: string;
  stripe_customer_id?: string;
  last_sync_at?: string;
  sync_status: 'synced' | 'pending' | 'error';
  stripe_webhook_events?: string[];
  jurisdiction?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateSubscriptionDto {
  user_id: string;
  plan_id: string;
  billing_cycle: 'monthly' | 'yearly';
  status?: 'active' | 'cancelled' | 'expired' | 'past_due' | 'unpaid';
  stripe_subscription_id?: string;
  stripe_customer_id?: string;
  jurisdiction?: string;
}

export interface UpdateSubscriptionDto {
  status?: 'active' | 'cancelled' | 'expired' | 'past_due' | 'unpaid';
  current_period_end?: string;
  cancelled_at?: string;
  plan_id?: string;
  stripe_subscription_id?: string;
  stripe_customer_id?: string;
  last_sync_at?: string;
  sync_status?: 'synced' | 'pending' | 'error';
  stripe_webhook_events?: string[];
}

export interface SubscriptionWithPlan extends Subscription {
  plan: {
    id: string;
    name: string;
    description: string;
    monthly_price: number;
    yearly_price: number;
    consultation_limit: number | null;
    document_analysis_limit: number | null;
    message_limit: number | null;
    is_unlimited: boolean;
    jurisdiction: string;
    ddi: string;
    stripe_product_id?: string;
    stripe_price_id_monthly?: string;
    stripe_price_id_yearly?: string;
    features: string[];
  };
} 
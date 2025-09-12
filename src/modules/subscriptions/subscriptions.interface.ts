export interface Subscription {
  id: string;
  user_id: string;
  plan_id: string;
  status: 'active' | 'cancelled' | 'expired';
  billing_cycle: 'monthly' | 'yearly';
  current_period_start: string;
  current_period_end: string;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateSubscriptionDto {
  user_id: string;
  plan_id: string;
  billing_cycle: 'monthly' | 'yearly';
  status?: 'active' | 'cancelled' | 'expired';
}

export interface UpdateSubscriptionDto {
  status?: 'active' | 'cancelled' | 'expired';
  current_period_end?: string;
  cancelled_at?: string;
}

export interface SubscriptionWithPlan extends Subscription {
  plan: {
    id: string;
    name: string;
    description: string;
    monthly_price: number;
    yearly_price: number;
    expense_limit: number | null;
    report_limit: number | null;
    message_limit: number | null;
    is_unlimited: boolean;
  };
} 
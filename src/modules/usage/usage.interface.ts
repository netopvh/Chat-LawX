export interface UsageTracking {
  id: string;
  user_id: string;
  subscription_id: string;
  period_start: string;
  period_end: string;
  expenses_count: number;
  revenues_count: number;
  reports_count: number;
  messages_count: number;
  created_at: string;
  updated_at: string;
}

export interface UsageLimits {
  allowed: boolean;
  message: string;
  current: number;
  limit: number | null;
  plan_name: string;
}

export interface CurrentUsage {
  expenses_count: number;
  revenues_count: number;
  reports_count: number;
  messages_count: number;
  period_start: string;
  period_end: string;
}

export interface UsageSummary {
  user_id: string;
  plan_name: string;
  current_usage: CurrentUsage;
  limits: {
    expense_limit: number | null;
    revenue_limit: number | null;
    report_limit: number | null;
    message_limit: number | null;
    is_unlimited: boolean;
  };
} 
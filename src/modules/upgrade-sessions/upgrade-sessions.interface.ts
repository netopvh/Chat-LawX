export interface UpgradeSession {
  id: string;
  user_id: string;
  phone: string;
  plan_name: string;
  billing_cycle: 'monthly' | 'yearly';
  amount: number;
  status: 'active' | 'completed' | 'expired' | 'failed' | 'cancelled' | 'payment_processing' | 'payment_confirmed' | 'payment_failed';
  current_step: 'plan_selection' | 'frequency_selection' | 'payment_info' | 'payment_processing' | 'confirmation' | 'expired';
  attempts_count: number;
  last_attempt_at: string | null;
  jurisdiction?: string; // BR, PT, ES
  stripe_checkout_url?: string; // URL do Stripe Checkout
  stripe_checkout_session_id?: string; // ID da sessão do Stripe
  completed_at?: string; // Data de conclusão
  payment_confirmed_at?: string; // Data de confirmação do pagamento
  payment_failed_at?: string; // Data de falha do pagamento
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface CreateUpgradeSessionDto {
  user_id: string;
  phone: string;
  plan_name: string;
  billing_cycle: 'monthly' | 'yearly';
  amount: number;
  current_step: 'plan_selection' | 'frequency_selection' | 'payment_info' | 'payment_processing' | 'confirmation';
  jurisdiction?: string; // BR, PT, ES
}

export interface UpdateUpgradeSessionDto {
  status?: 'active' | 'completed' | 'expired' | 'failed' | 'cancelled' | 'payment_processing' | 'payment_confirmed' | 'payment_failed';
  current_step?: 'plan_selection' | 'frequency_selection' | 'payment_info' | 'payment_processing' | 'confirmation' | 'expired';
  attempts_count?: number;
  last_attempt_at?: string;
  plan_name?: string;
  billing_cycle?: 'monthly' | 'yearly';
  amount?: number;
  jurisdiction?: string; // BR, PT, ES
  stripe_checkout_url?: string; // URL do Stripe Checkout
  stripe_checkout_session_id?: string; // ID da sessão do Stripe
  completed_at?: string; // Data de conclusão
  payment_confirmed_at?: string; // Data de confirmação do pagamento
  payment_failed_at?: string; // Data de falha do pagamento
}

export interface UpgradeAttempt {
  id: string;
  session_id: string;
  step: string;
  success: boolean;
  error_message?: string;
  created_at: string;
}

export interface CreateUpgradeAttemptDto {
  session_id: string;
  step: string;
  success: boolean;
  error_message?: string;
}

export interface UpgradeIntent {
  hasActiveSession: boolean;
  session?: UpgradeSession;
  intent: boolean;
  hasIntent?: boolean;
  confidence?: number;
  detectedPlans?: string[];
} 
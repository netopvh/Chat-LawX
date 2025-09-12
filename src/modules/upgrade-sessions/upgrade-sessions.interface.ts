export interface UpgradeSession {
  id: string;
  user_id: string;
  phone: string;
  plan_name: string;
  billing_cycle: 'monthly' | 'yearly';
  amount: number;
  status: 'active' | 'completed' | 'expired' | 'failed' | 'cancelled';
  current_step: 'plan_selection' | 'frequency_selection' | 'payment_info' | 'pix_generation' | 'payment_pending' | 'confirmation';
  attempts_count: number;
  last_attempt_at: string | null;
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
  current_step: 'plan_selection' | 'frequency_selection' | 'payment_info' | 'pix_generation' | 'payment_pending' | 'confirmation';
}

export interface UpdateUpgradeSessionDto {
  status?: 'active' | 'completed' | 'expired' | 'failed' | 'cancelled';
  current_step?: 'plan_selection' | 'frequency_selection' | 'payment_info' | 'pix_generation' | 'payment_pending' | 'confirmation';
  attempts_count?: number;
  last_attempt_at?: string;
  plan_name?: string;
  billing_cycle?: 'monthly' | 'yearly';
  amount?: number;
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
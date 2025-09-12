export interface UsageTracking {
  id: string;
  user_id: string;
  subscription_id: string;
  period_start: string;
  period_end: string;
  consultations_count: number; // Consultas jurídicas
  document_analysis_count: number; // Análises de documentos
  messages_count: number; // Mensagens da IA
  jurisdiction: string; // BR, PT, ES
  created_at: string;
  updated_at: string;
}

export interface UsageLimits {
  allowed: boolean;
  message: string;
  current: number;
  limit: number | null;
  plan_name: string;
  jurisdiction: string; // BR, PT, ES
  limit_type: 'consultation' | 'document_analysis' | 'message'; // Tipo de limite
}

export interface CurrentUsage {
  consultations_count: number; // Consultas jurídicas
  document_analysis_count: number; // Análises de documentos
  messages_count: number; // Mensagens da IA
  period_start: string;
  period_end: string;
  jurisdiction: string; // BR, PT, ES
}

export interface UsageSummary {
  user_id: string;
  plan_name: string;
  current_usage: CurrentUsage;
  limits: {
    consultation_limit: number | null; // Limite de consultas jurídicas
    document_analysis_limit: number | null; // Limite de análises de documentos
    message_limit: number | null; // Limite de mensagens da IA
    is_unlimited: boolean;
    jurisdiction: string; // BR, PT, ES
  };
} 
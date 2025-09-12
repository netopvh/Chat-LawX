export interface Plan {
  id: string;
  name: string;
  description: string;
  monthly_price: number;
  yearly_price: number;
  consultation_limit: number | null; // Limite de consultas jurídicas (apenas para PT/ES)
  document_analysis_limit: number | null; // Limite de análises de documentos
  message_limit: number | null; // Limite de mensagens (apenas para PT/ES)
  is_unlimited: boolean;
  is_active: boolean;
  jurisdiction: string; // BR, PT, ES
  ddi: string; // 55, 351, 34
  stripe_price_id_monthly?: string;
  stripe_price_id_yearly?: string;
  stripe_product_id?: string;
  features: string[]; // Array de funcionalidades incluídas
  created_at: string;
  updated_at: string;
}

export interface CreatePlanDto {
  name: string;
  description: string;
  monthly_price: number;
  yearly_price: number;
  consultation_limit?: number;
  document_analysis_limit?: number;
  message_limit?: number;
  is_unlimited?: boolean;
  jurisdiction: string;
  ddi: string;
  stripe_price_id_monthly?: string;
  stripe_price_id_yearly?: string;
  stripe_product_id?: string;
  features?: string[];
}

export interface UpdatePlanDto {
  name?: string;
  description?: string;
  monthly_price?: number;
  yearly_price?: number;
  consultation_limit?: number;
  document_analysis_limit?: number;
  message_limit?: number;
  is_unlimited?: boolean;
  is_active?: boolean;
  jurisdiction?: string;
  ddi?: string;
  stripe_price_id_monthly?: string;
  stripe_price_id_yearly?: string;
  stripe_product_id?: string;
  features?: string[];
} 
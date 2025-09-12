export interface Plan {
  id: string;
  name: string;
  description: string;
  monthly_price: number;
  yearly_price: number;
  expense_limit: number | null;
  revenue_limit: number | null;
  report_limit: number | null;
  message_limit: number | null;
  is_unlimited: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreatePlanDto {
  name: string;
  description: string;
  monthly_price: number;
  yearly_price: number;
  expense_limit?: number;
  revenue_limit?: number;
  report_limit?: number;
  message_limit?: number;
  is_unlimited?: boolean;
}

export interface UpdatePlanDto {
  name?: string;
  description?: string;
  monthly_price?: number;
  yearly_price?: number;
  expense_limit?: number;
  revenue_limit?: number;
  report_limit?: number;
  message_limit?: number;
  is_unlimited?: boolean;
  is_active?: boolean;
} 
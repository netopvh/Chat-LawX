import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { StripeService } from '../stripe/stripe.service';
import { JurisdictionService } from '../jurisdiction/jurisdiction.service';
import { Plan, CreatePlanDto, UpdatePlanDto } from './plans.interface';

@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly stripeService: StripeService,
    private readonly jurisdictionService: JurisdictionService,
  ) {}

  async getAllPlans(jurisdiction?: string): Promise<Plan[]> {
    try {
      let query = this.supabaseService.getClient()
        .from('plans')
        .select('*')
        .eq('is_active', true);

      if (jurisdiction) {
        query = query.eq('jurisdiction', jurisdiction);
      }

      const { data, error } = await query.order('monthly_price', { ascending: true });

      if (error) {
        this.logger.error('Erro ao buscar planos:', error);
        throw new Error('Erro ao buscar planos');
      }

      return data || [];
    } catch (error) {
      this.logger.error('Erro no serviço de planos:', error);
      throw error;
    }
  }

  async getUpgradePlans(jurisdiction?: string): Promise<Plan[]> {
    try {
      let query = this.supabaseService.getClient()
        .from('plans')
        .select('*')
        .eq('is_active', true)
        .neq('name', 'Fremium') // Excluir plano Fremium
        .gt('monthly_price', 0); // Apenas planos pagos

      if (jurisdiction) {
        query = query.eq('jurisdiction', jurisdiction);
      }

      const { data, error } = await query.order('monthly_price', { ascending: true });

      if (error) {
        this.logger.error('Erro ao buscar planos de upgrade:', error);
        throw new Error('Erro ao buscar planos de upgrade');
      }

      return data || [];
    } catch (error) {
      this.logger.error('Erro no serviço de planos:', error);
      throw error;
    }
  }

  async getPlanById(id: string): Promise<Plan> {
    try {
      const { data, error } = await this.supabaseService.getClient()
        .from('plans')
        .select('*')
        .eq('id', id)
        .single();

      if (error) {
        this.logger.error('Erro ao buscar plano por ID:', error);
        throw new Error('Plano não encontrado');
      }

      return data;
    } catch (error) {
      this.logger.error('Erro no serviço de planos:', error);
      throw error;
    }
  }

  async getPlanByName(name: string): Promise<Plan> {
    try {
      const { data, error } = await this.supabaseService.getClient()
        .from('plans')
        .select('*')
        .eq('name', name)
        .eq('is_active', true)
        .single();

      if (error) {
        this.logger.error('Erro ao buscar plano por nome:', error);
        throw new Error(`Plano ${name} não encontrado`);
      }

      return data;
    } catch (error) {
      this.logger.error('Erro no serviço de planos:', error);
      throw error;
    }
  }

  async createPlan(createPlanDto: CreatePlanDto): Promise<Plan> {
    try {
      const { data, error } = await this.supabaseService.getClient()
        .from('plans')
        .insert(createPlanDto)
        .select()
        .single();

      if (error) {
        this.logger.error('Erro ao criar plano:', error);
        throw new Error('Erro ao criar plano');
      }

      this.logger.log(`Plano ${data.name} criado com sucesso`);
      return data;
    } catch (error) {
      this.logger.error('Erro no serviço de planos:', error);
      throw error;
    }
  }

  async updatePlan(id: string, updatePlanDto: UpdatePlanDto): Promise<Plan> {
    try {
      const { data, error } = await this.supabaseService.getClient()
        .from('plans')
        .update({ ...updatePlanDto, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();

      if (error) {
        this.logger.error('Erro ao atualizar plano:', error);
        throw new Error('Erro ao atualizar plano');
      }

      this.logger.log(`Plano ${data.name} atualizado com sucesso`);
      return data;
    } catch (error) {
      this.logger.error('Erro no serviço de planos:', error);
      throw error;
    }
  }

  async deletePlan(id: string): Promise<void> {
    try {
      const { error } = await this.supabaseService.getClient()
        .from('plans')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', id);

      if (error) {
        this.logger.error('Erro ao deletar plano:', error);
        throw new Error('Erro ao deletar plano');
      }

      this.logger.log(`Plano ${id} deletado com sucesso`);
    } catch (error) {
      this.logger.error('Erro no serviço de planos:', error);
      throw error;
    }
  }

  async getFremiumPlan(): Promise<Plan> {
    return this.getPlanByName('Fremium');
  }

  async getProPlan(): Promise<Plan> {
    return this.getPlanByName('Pro');
  }

  async getPremiumPlan(): Promise<Plan> {
    return this.getPlanByName('Premium');
  }

  // ===== NOVOS MÉTODOS PARA CHAT LAWX =====

  /**
   * Cria plano com integração Stripe
   */
  async createPlanWithStripe(createPlanDto: CreatePlanDto): Promise<Plan> {
    try {
      // Criar produto no Stripe
      const stripeProduct = await this.stripeService.createProduct({
        name: createPlanDto.name,
        description: createPlanDto.description,
        metadata: {
          jurisdiction: createPlanDto.jurisdiction,
          ddi: createPlanDto.ddi,
        },
      });

      // Criar preços no Stripe
      const stripePriceMonthly = await this.stripeService.createPrice({
        product: stripeProduct.id,
        unit_amount: Math.round(createPlanDto.monthly_price * 100), // Converter para centavos
        currency: this.jurisdictionService.getCurrency(createPlanDto.jurisdiction),
        recurring: { interval: 'month' },
      });

      const stripePriceYearly = await this.stripeService.createPrice({
        product: stripeProduct.id,
        unit_amount: Math.round(createPlanDto.yearly_price * 100), // Converter para centavos
        currency: this.jurisdictionService.getCurrency(createPlanDto.jurisdiction),
        recurring: { interval: 'year' },
      });

      // Criar plano no Supabase com IDs do Stripe
      const planData = {
        ...createPlanDto,
        stripe_product_id: stripeProduct.id,
        stripe_price_id_monthly: stripePriceMonthly.id,
        stripe_price_id_yearly: stripePriceYearly.id,
        features: createPlanDto.features || [],
      };

      return await this.createPlan(planData);
    } catch (error) {
      this.logger.error('Erro ao criar plano com Stripe:', error);
      throw error;
    }
  }

  /**
   * Busca planos por jurisdição
   */
  async getPlansByJurisdiction(jurisdiction: string): Promise<Plan[]> {
    return this.getAllPlans(jurisdiction);
  }

  /**
   * Busca planos de upgrade por jurisdição
   */
  async getUpgradePlansByJurisdiction(jurisdiction: string): Promise<Plan[]> {
    return this.getUpgradePlans(jurisdiction);
  }

  /**
   * Valida limites de plano para jurisdição
   */
  async validatePlanLimits(planId: string, jurisdiction: string): Promise<{
    isValid: boolean;
    limits: any;
    message?: string;
  }> {
    try {
      const plan = await this.getPlanById(planId);
      
      if (plan.jurisdiction !== jurisdiction) {
        return {
          isValid: false,
          limits: null,
          message: 'Plano não disponível para esta jurisdição',
        };
      }

      const limitControlType = this.jurisdictionService.getLimitControlType(jurisdiction);
      
      if (limitControlType === 'teams') {
        // Para Brasil - limites controlados via Supabase teams
        return {
          isValid: true,
          limits: {
            type: 'teams',
            message: 'Limites controlados via sistema de teams',
          },
        };
      } else {
        // Para Portugal/Espanha - limites locais
        return {
          isValid: true,
          limits: {
            type: 'local',
            consultation_limit: plan.consultation_limit,
            document_analysis_limit: plan.document_analysis_limit,
            message_limit: plan.message_limit,
          },
        };
      }
    } catch (error) {
      this.logger.error('Erro ao validar limites do plano:', error);
      return {
        isValid: false,
        limits: null,
        message: 'Erro ao validar limites do plano',
      };
    }
  }

  /**
   * Sincroniza planos com Stripe
   */
  async syncPlansWithStripe(): Promise<void> {
    try {
      const plans = await this.getAllPlans();
      
      for (const plan of plans) {
        if (!plan.stripe_product_id) {
          // Criar produto no Stripe se não existir
          const stripeProduct = await this.stripeService.createProduct({
            name: plan.name,
            description: plan.description,
            metadata: {
              jurisdiction: plan.jurisdiction,
              ddi: plan.ddi,
            },
          });

          // Atualizar plano com ID do Stripe
          await this.updatePlan(plan.id, {
            stripe_product_id: stripeProduct.id,
          });
        }
      }
      
      this.logger.log('Sincronização com Stripe concluída');
    } catch (error) {
      this.logger.error('Erro ao sincronizar planos com Stripe:', error);
      throw error;
    }
  }
} 
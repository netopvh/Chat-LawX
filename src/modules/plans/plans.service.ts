import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { JurisdictionService } from '../jurisdiction/jurisdiction.service';
import { Plan, CreatePlanDto, UpdatePlanDto } from './plans.interface';

@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly stripeService: StripeService,
    private readonly jurisdictionService: JurisdictionService,
  ) {}

  private mapPrismaPlanToInterface(p: any): Plan {
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      monthly_price: p.monthlyPrice,
      yearly_price: p.yearlyPrice,
      consultation_limit: p.consultationLimit ?? null,
      document_analysis_limit: p.documentAnalysisLimit ?? null,
      message_limit: p.messageLimit ?? null,
      is_unlimited: p.isUnlimited,
      is_active: p.isActive,
      jurisdiction: p.jurisdiction,
      ddi: p.ddi,
      stripe_price_id_monthly: p.stripePriceIdMonthly,
      stripe_price_id_yearly: p.stripePriceIdYearly,
      stripe_product_id: p.stripeProductId,
      features: Array.isArray(p.features) ? p.features : [],
      created_at: p.createdAt.toISOString(),
      updated_at: p.updatedAt.toISOString(),
    };
  }

  private mapCreateDtoToPrismaData(dto: CreatePlanDto): any {
    return {
      name: (dto as any).name,
      description: (dto as any).description,
      monthlyPrice: (dto as any).monthly_price,
      yearlyPrice: (dto as any).yearly_price,
      consultationLimit: (dto as any).consultation_limit,
      documentAnalysisLimit: (dto as any).document_analysis_limit,
      messageLimit: (dto as any).message_limit,
      isUnlimited: (dto as any).is_unlimited,
      isActive: (dto as any).is_active,
      jurisdiction: (dto as any).jurisdiction,
      ddi: (dto as any).ddi,
      stripePriceIdMonthly: (dto as any).stripe_price_id_monthly,
      stripePriceIdYearly: (dto as any).stripe_price_id_yearly,
      stripeProductId: (dto as any).stripe_product_id,
      features: (dto as any).features ?? [],
    };
  }

  private mapUpdateDtoToPrismaData(dto: UpdatePlanDto): any {
    const data = {
      name: (dto as any).name,
      description: (dto as any).description,
      monthlyPrice: (dto as any).monthly_price,
      yearlyPrice: (dto as any).yearly_price,
      consultationLimit: (dto as any).consultation_limit,
      documentAnalysisLimit: (dto as any).document_analysis_limit,
      messageLimit: (dto as any).message_limit,
      isUnlimited: (dto as any).is_unlimited,
      isActive: (dto as any).is_active,
      jurisdiction: (dto as any).jurisdiction,
      ddi: (dto as any).ddi,
      stripePriceIdMonthly: (dto as any).stripe_price_id_monthly,
      stripePriceIdYearly: (dto as any).stripe_price_id_yearly,
      stripeProductId: (dto as any).stripe_product_id,
      features: (dto as any).features,
    } as Record<string, any>;

    // Remove campos undefined para evitar sobrescritas indesejadas
    Object.keys(data).forEach((key) => data[key] === undefined && delete data[key]);
    return data;
  }

  async getAllPlans(jurisdiction?: string): Promise<Plan[]> {
    try {
      const plans = await (this.prismaService as any).plan.findMany({
        where: {
          isActive: true,
          ...(jurisdiction ? { jurisdiction } : {}),
        },
        orderBy: { monthlyPrice: 'asc' },
      });

      return (plans || []).map((p: any) => this.mapPrismaPlanToInterface(p));
    } catch (error) {
      this.logger.error('Erro ao buscar planos (Prisma):', error);
      throw error;
    }
  }

  async getUpgradePlans(jurisdiction?: string): Promise<Plan[]> {
    try {
      const plans = await (this.prismaService as any).plan.findMany({
        where: {
          isActive: true,
          name: { not: 'Fremium' },
          monthlyPrice: { gt: 0 },
          ...(jurisdiction ? { jurisdiction } : {}),
        },
        orderBy: { monthlyPrice: 'asc' },
      });
      return (plans || []).map((p: any) => this.mapPrismaPlanToInterface(p));
    } catch (error) {
      this.logger.error('Erro ao buscar planos de upgrade (Prisma):', error);
      throw error;
    }
  }

  async getPlanById(id: string): Promise<Plan> {
    try {
      const plan = await (this.prismaService as any).plan.findUnique({ where: { id } });

      if (!plan) {
        throw new Error('Plano não encontrado');
      }

      return this.mapPrismaPlanToInterface(plan);
    } catch (error) {
      this.logger.error('Erro ao buscar plano por ID (Prisma):', error);
      throw error;
    }
  }

  async getPlanByName(name: string): Promise<Plan> {
    try {
      const prismaPlan = await (this.prismaService as any).plan.findFirst({
        where: { name, isActive: true },
      });
      if (!prismaPlan) {
        throw new Error(`Plano ${name} não encontrado`);
      }
      return this.mapPrismaPlanToInterface(prismaPlan);
    } catch (error) {
      this.logger.error('Erro ao buscar plano por nome (Prisma):', error);
      throw error;
    }
  }

  async createPlan(createPlanDto: CreatePlanDto): Promise<Plan> {
    try {
      const dataToCreate = this.mapCreateDtoToPrismaData(createPlanDto);
      const created = await (this.prismaService as any).plan.create({ data: dataToCreate });
      this.logger.log(`Plano ${created.name} criado com sucesso (Prisma)`);
      return this.mapPrismaPlanToInterface(created);
    } catch (error) {
      this.logger.error('Erro ao criar plano (Prisma):', error);
      throw error;
    }
  }

  async updatePlan(id: string, updatePlanDto: UpdatePlanDto): Promise<Plan> {
    try {
      const dataToUpdate = this.mapUpdateDtoToPrismaData(updatePlanDto);
      const updated = await (this.prismaService as any).plan.update({ where: { id }, data: dataToUpdate });
      this.logger.log(`Plano ${updated.name} atualizado com sucesso (Prisma)`);
      return this.mapPrismaPlanToInterface(updated);
    } catch (error) {
      this.logger.error('Erro ao atualizar plano (Prisma):', error);
      throw error;
    }
  }

  async deletePlan(id: string): Promise<void> {
    try {
      await (this.prismaService as any).plan.update({
        where: { id },
        data: { isActive: false },
      });

      this.logger.log(`Plano ${id} desativado com sucesso (Prisma)`);
    } catch (error) {
      this.logger.error('Erro ao desativar plano (Prisma):', error);
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
        productId: stripeProduct.id,
        unitAmount: Math.round(createPlanDto.monthly_price * 100), // Converter para centavos
        currency: this.jurisdictionService.getCurrency(createPlanDto.jurisdiction),
        recurring: { interval: 'month', intervalCount: 1 },
      });

      const stripePriceYearly = await this.stripeService.createPrice({
        productId: stripeProduct.id,
        unitAmount: Math.round(createPlanDto.yearly_price * 100), // Converter para centavos
        currency: this.jurisdictionService.getCurrency(createPlanDto.jurisdiction),
        recurring: { interval: 'year', intervalCount: 1 },
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
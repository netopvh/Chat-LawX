import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { Plan, CreatePlanDto, UpdatePlanDto } from './plans.interface';

@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  async getAllPlans(): Promise<Plan[]> {
    try {
      const { data, error } = await this.supabaseService.getClient()
        .from('plans')
        .select('*')
        .eq('is_active', true)
        .order('monthly_price', { ascending: true });

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

  async getUpgradePlans(): Promise<Plan[]> {
    try {
      const { data, error } = await this.supabaseService.getClient()
        .from('plans')
        .select('*')
        .eq('is_active', true)
        .neq('name', 'Fremium') // Excluir plano Fremium
        .order('monthly_price', { ascending: true });

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
} 
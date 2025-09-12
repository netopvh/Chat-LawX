import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import {
  Team,
  TeamMember,
  TeamUsage,
  TeamLimitValidation,
  UpdateTeamUsageDto,
  CreateTeamDto,
  UpdateTeamDto,
  TeamQueryOptions,
  TeamStats,
} from './interfaces/team.interface';

@Injectable()
export class TeamsService {
  private readonly logger = new Logger(TeamsService.name);

  constructor(private supabaseService: SupabaseService) {}

  /**
   * Busca um team por ID
   */
  async getTeamById(teamId: string, options: TeamQueryOptions = {}): Promise<Team | null> {
    try {
      const { data, error } = await this.supabaseService
        .getClient()
        .from('teams')
        .select('*')
        .eq('id', teamId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          this.logger.warn(`Team não encontrado: ${teamId}`);
          return null;
        }
        throw error;
      }

      this.logger.log(`Team encontrado: ${teamId}`);
      return data as Team;
    } catch (error) {
      this.logger.error(`Erro ao buscar team ${teamId}:`, error);
      throw error;
    }
  }

  /**
   * Busca teams por nome
   */
  async getTeamsByName(name: string, options: TeamQueryOptions = {}): Promise<Team[]> {
    try {
      const { data, error } = await this.supabaseService
        .getClient()
        .from('teams')
        .select('*')
        .ilike('name', `%${name}%`)
        .limit(options.limit || 10)
        .range(options.offset || 0, (options.offset || 0) + (options.limit || 10) - 1);

      if (error) {
        throw error;
      }

      this.logger.log(`Encontrados ${data.length} teams com nome: ${name}`);
      return data as Team[];
    } catch (error) {
      this.logger.error(`Erro ao buscar teams por nome ${name}:`, error);
      throw error;
    }
  }

  /**
   * Lista todos os teams
   */
  async getAllTeams(options: TeamQueryOptions = {}): Promise<Team[]> {
    try {
      const { data, error } = await this.supabaseService
        .getClient()
        .from('teams')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(options.limit || 50)
        .range(options.offset || 0, (options.offset || 0) + (options.limit || 50) - 1);

      if (error) {
        throw error;
      }

      this.logger.log(`Listados ${data.length} teams`);
      return data as Team[];
    } catch (error) {
      this.logger.error('Erro ao listar teams:', error);
      throw error;
    }
  }

  /**
   * Valida se um team pode enviar mensagem (controle de limite)
   */
  async validateTeamLimit(teamId: string): Promise<TeamLimitValidation> {
    try {
      const team = await this.getTeamById(teamId);
      
      if (!team) {
        throw new NotFoundException(`Team não encontrado: ${teamId}`);
      }

      const canSendMessage = team.messages_used < team.messages;
      const remaining = Math.max(0, team.messages - team.messages_used);

      const validation: TeamLimitValidation = {
        isValid: true,
        canSendMessage,
        currentUsage: team.messages_used,
        limit: team.messages,
        remaining,
        team,
      };

      this.logger.log(`Validação de limite para team ${teamId}: ${team.messages_used}/${team.messages} (${canSendMessage ? 'OK' : 'LIMITE ATINGIDO'})`);
      return validation;
    } catch (error) {
      this.logger.error(`Erro ao validar limite do team ${teamId}:`, error);
      throw error;
    }
  }

  /**
   * Incrementa o contador de mensagens usadas de um team
   */
  async incrementTeamUsage(teamId: string, increment: number = 1): Promise<Team> {
    try {
      const { data, error } = await this.supabaseService
        .getClient()
        .from('teams')
        .update({
          messages_used: this.supabaseService.getClient().rpc('increment', {
            table_name: 'teams',
            column_name: 'messages_used',
            id: teamId,
            increment_value: increment,
          }),
          updated_at: new Date().toISOString(),
        })
        .eq('id', teamId)
        .select()
        .single();

      if (error) {
        throw error;
      }

      this.logger.log(`Uso incrementado para team ${teamId}: +${increment} mensagens`);
      return data as Team;
    } catch (error) {
      this.logger.error(`Erro ao incrementar uso do team ${teamId}:`, error);
      throw error;
    }
  }

  /**
   * Atualiza o uso de mensagens de um team
   */
  async updateTeamUsage(updateData: UpdateTeamUsageDto): Promise<Team> {
    try {
      const { team_id, increment, set_value } = updateData;
      
      let updateFields: any = {
        updated_at: new Date().toISOString(),
      };

      if (set_value !== undefined) {
        updateFields.messages_used = set_value;
      } else if (increment !== undefined) {
        updateFields.messages_used = this.supabaseService.getClient().rpc('increment', {
          table_name: 'teams',
          column_name: 'messages_used',
          id: team_id,
          increment_value: increment,
        });
      }

      const { data, error } = await this.supabaseService
        .getClient()
        .from('teams')
        .update(updateFields)
        .eq('id', team_id)
        .select()
        .single();

      if (error) {
        throw error;
      }

      this.logger.log(`Uso atualizado para team ${team_id}`);
      return data as Team;
    } catch (error) {
      this.logger.error(`Erro ao atualizar uso do team ${updateData.team_id}:`, error);
      throw error;
    }
  }

  /**
   * Cria um novo team
   */
  async createTeam(createData: CreateTeamDto): Promise<Team> {
    try {
      const { data, error } = await this.supabaseService
        .getClient()
        .from('teams')
        .insert({
          name: createData.name,
          messages: createData.messages,
          messages_used: 0,
          metadata: createData.metadata || {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (error) {
        throw error;
      }

      this.logger.log(`Team criado: ${data.id} - ${data.name}`);
      return data as Team;
    } catch (error) {
      this.logger.error('Erro ao criar team:', error);
      throw error;
    }
  }

  /**
   * Atualiza um team
   */
  async updateTeam(teamId: string, updateData: UpdateTeamDto): Promise<Team> {
    try {
      const { data, error } = await this.supabaseService
        .getClient()
        .from('teams')
        .update({
          ...updateData,
          updated_at: new Date().toISOString(),
        })
        .eq('id', teamId)
        .select()
        .single();

      if (error) {
        throw error;
      }

      this.logger.log(`Team atualizado: ${teamId}`);
      return data as Team;
    } catch (error) {
      this.logger.error(`Erro ao atualizar team ${teamId}:`, error);
      throw error;
    }
  }

  /**
   * Obtém estatísticas dos teams
   */
  async getTeamStats(): Promise<TeamStats> {
    try {
      const { data, error } = await this.supabaseService
        .getClient()
        .from('teams')
        .select('messages, messages_used');

      if (error) {
        throw error;
      }

      const teams = data as Team[];
      const totalTeams = teams.length;
      const totalMessagesUsed = teams.reduce((sum, team) => sum + team.messages_used, 0);
      const totalMessagesLimit = teams.reduce((sum, team) => sum + team.messages, 0);
      const averageUsagePercentage = totalMessagesLimit > 0 ? (totalMessagesUsed / totalMessagesLimit) * 100 : 0;
      const teamsAtLimit = teams.filter(team => team.messages_used >= team.messages).length;
      const teamsOverLimit = teams.filter(team => team.messages_used > team.messages).length;

      const stats: TeamStats = {
        total_teams: totalTeams,
        total_messages_used: totalMessagesUsed,
        total_messages_limit: totalMessagesLimit,
        average_usage_percentage: Math.round(averageUsagePercentage * 100) / 100,
        teams_at_limit: teamsAtLimit,
        teams_over_limit: teamsOverLimit,
      };

      this.logger.log(`Estatísticas dos teams: ${totalTeams} teams, ${totalMessagesUsed}/${totalMessagesLimit} mensagens`);
      return stats;
    } catch (error) {
      this.logger.error('Erro ao obter estatísticas dos teams:', error);
      throw error;
    }
  }

  /**
   * Obtém uso detalhado de um team
   */
  async getTeamUsage(teamId: string): Promise<TeamUsage> {
    try {
      const team = await this.getTeamById(teamId);
      
      if (!team) {
        throw new NotFoundException(`Team não encontrado: ${teamId}`);
      }

      const usagePercentage = team.messages > 0 ? (team.messages_used / team.messages) * 100 : 0;
      const isLimitReached = team.messages_used >= team.messages;

      const usage: TeamUsage = {
        team_id: teamId,
        messages_used: team.messages_used,
        messages_limit: team.messages,
        usage_percentage: Math.round(usagePercentage * 100) / 100,
        last_message_at: team.updated_at,
        is_limit_reached: isLimitReached,
      };

      this.logger.log(`Uso do team ${teamId}: ${team.messages_used}/${team.messages} (${usagePercentage.toFixed(2)}%)`);
      return usage;
    } catch (error) {
      this.logger.error(`Erro ao obter uso do team ${teamId}:`, error);
      throw error;
    }
  }
}

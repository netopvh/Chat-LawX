export interface Team {
  id: string;
  name: string;
  admin_id: string; // ID do usuário administrador do team
  messages: number; // Limite de mensagens
  messages_used: number; // Contador de mensagens usadas
  created_at: string;
  updated_at: string;
  metadata?: Record<string, any>;
}

export interface TeamMember {
  id: string;
  team_id: string;
  user_id: string;
  role: 'admin' | 'member';
  created_at: string;
  updated_at: string;
}

export interface TeamUsage {
  team_id: string;
  messages_used: number;
  messages_limit: number;
  usage_percentage: number;
  last_message_at?: string;
  is_limit_reached: boolean;
}

export interface TeamLimitValidation {
  isValid: boolean;
  canSendMessage: boolean;
  currentUsage: number;
  limit: number;
  remaining: number;
  team: Team;
}

export interface UpdateTeamUsageDto {
  team_id: string;
  increment?: number;
  set_value?: number;
}

export interface CreateTeamDto {
  name: string;
  admin_id: string;
  messages: number;
  metadata?: Record<string, any>;
}

export interface UpdateTeamDto {
  name?: string;
  messages?: number;
  metadata?: Record<string, any>;
}

export interface TeamQueryOptions {
  include_members?: boolean;
  include_usage?: boolean;
  limit?: number;
  offset?: number;
}

export interface TeamStats {
  total_teams: number;
  total_messages_used: number;
  total_messages_limit: number;
  average_usage_percentage: number;
  teams_at_limit: number;
  teams_over_limit: number;
}

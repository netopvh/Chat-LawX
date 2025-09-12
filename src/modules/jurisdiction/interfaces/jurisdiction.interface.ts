export interface JurisdictionConfig {
  ddi: string;
  country: string;
  jurisdiction: string;
  language: string;
  currency: string;
  timezone: string;
  database: 'supabase' | 'mysql';
  limitControl: 'teams' | 'local';
}

export interface DDIDetectionResult {
  ddi: string;
  country: string;
  jurisdiction: string;
  isValid: boolean;
  config: JurisdictionConfig;
}

export interface LimitValidationResult {
  isValid: boolean;
  currentUsage: number;
  limit: number;
  remaining: number;
  jurisdiction: string;
  controlType: 'teams' | 'local';
}

export interface JurisdictionRules {
  supportedDDIs: string[];
  defaultJurisdiction: string;
  fallbackJurisdiction: string;
  limitValidationEnabled: boolean;
  messageCountingEnabled: boolean;
}

export const JURISDICTION_CONFIGS: Record<string, JurisdictionConfig> = {
  '55': {
    ddi: '55',
    country: 'Brasil',
    jurisdiction: 'BR',
    language: 'pt-BR',
    currency: 'BRL',
    timezone: 'America/Sao_Paulo',
    database: 'supabase',
    limitControl: 'teams',
  },
  '351': {
    ddi: '351',
    country: 'Portugal',
    jurisdiction: 'PT',
    language: 'pt-PT',
    currency: 'EUR',
    timezone: 'Europe/Lisbon',
    database: 'mysql',
    limitControl: 'local',
  },
  '34': {
    ddi: '34',
    country: 'Espanha',
    jurisdiction: 'ES',
    language: 'es-ES',
    currency: 'EUR',
    timezone: 'Europe/Madrid',
    database: 'mysql',
    limitControl: 'local',
  },
};

export const DEFAULT_JURISDICTION_RULES: JurisdictionRules = {
  supportedDDIs: ['55', '351', '34'],
  defaultJurisdiction: 'BR',
  fallbackJurisdiction: 'BR',
  limitValidationEnabled: true,
  messageCountingEnabled: true,
};

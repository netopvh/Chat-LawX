import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  JurisdictionConfig,
  DDIDetectionResult,
  LimitValidationResult,
  JurisdictionRules,
  JURISDICTION_CONFIGS,
  DEFAULT_JURISDICTION_RULES,
} from './interfaces/jurisdiction.interface';

@Injectable()
export class JurisdictionService {
  private readonly logger = new Logger(JurisdictionService.name);
  private readonly rules: JurisdictionRules;

  constructor(private configService: ConfigService) {
    this.rules = {
      supportedDDIs: this.configService.get<string>('SUPPORTED_JURISDICTIONS')?.split(',') || DEFAULT_JURISDICTION_RULES.supportedDDIs,
      defaultJurisdiction: this.configService.get<string>('DEFAULT_JURISDICTION') || DEFAULT_JURISDICTION_RULES.defaultJurisdiction,
      fallbackJurisdiction: DEFAULT_JURISDICTION_RULES.fallbackJurisdiction,
      limitValidationEnabled: this.configService.get<boolean>('MESSAGE_LIMIT_ENABLED') ?? DEFAULT_JURISDICTION_RULES.limitValidationEnabled,
      messageCountingEnabled: this.configService.get<boolean>('CONSULTATION_LIMIT_ENABLED') ?? DEFAULT_JURISDICTION_RULES.messageCountingEnabled,
    };
  }

  /**
   * Detecta a jurisdição baseada no DDI do número de telefone
   */
  detectJurisdiction(phoneNumber: string): DDIDetectionResult {
    try {
      // Remove caracteres não numéricos
      const cleanPhone = phoneNumber.replace(/\D/g, '');
      
      // Extrai o DDI (primeiros 2-3 dígitos)
      let ddi = '';
      let isValid = false;
      let config: JurisdictionConfig;

      // Tenta extrair DDI de 2 dígitos primeiro
      if (cleanPhone.length >= 2) {
        ddi = cleanPhone.substring(0, 2);
        config = JURISDICTION_CONFIGS[ddi];
        
        if (config) {
          isValid = true;
        } else {
          // Tenta DDI de 3 dígitos
          if (cleanPhone.length >= 3) {
            ddi = cleanPhone.substring(0, 3);
            config = JURISDICTION_CONFIGS[ddi];
            isValid = !!config;
          }
        }
      }

      // Se não encontrou, usa jurisdição padrão
      if (!isValid) {
        ddi = this.rules.defaultJurisdiction === 'BR' ? '55' : this.rules.defaultJurisdiction;
        config = JURISDICTION_CONFIGS[ddi];
        this.logger.warn(`DDI não reconhecido para ${phoneNumber}, usando padrão: ${ddi}`);
      }

      const result: DDIDetectionResult = {
        ddi,
        country: config.country,
        jurisdiction: config.jurisdiction,
        isValid,
        config,
      };

      this.logger.log(`Jurisdição detectada: ${result.jurisdiction} (${result.country}) para ${phoneNumber}`);
      return result;
    } catch (error) {
      this.logger.error(`Erro ao detectar jurisdição para ${phoneNumber}:`, error);
      
      // Retorna configuração padrão em caso de erro
      const fallbackConfig = JURISDICTION_CONFIGS[this.rules.fallbackJurisdiction === 'BR' ? '55' : this.rules.fallbackJurisdiction];
      return {
        ddi: fallbackConfig.ddi,
        country: fallbackConfig.country,
        jurisdiction: fallbackConfig.jurisdiction,
        isValid: false,
        config: fallbackConfig,
      };
    }
  }

  /**
   * Valida se o DDI é suportado
   */
  isDDISupported(ddi: string): boolean {
    return this.rules.supportedDDIs.includes(ddi);
  }

  /**
   * Obtém configuração da jurisdição
   */
  getJurisdictionConfig(jurisdiction: string): JurisdictionConfig | null {
    const config = Object.values(JURISDICTION_CONFIGS).find(c => c.jurisdiction === jurisdiction);
    return config || null;
  }

  /**
   * Obtém configuração por DDI
   */
  getConfigByDDI(ddi: string): JurisdictionConfig | null {
    return JURISDICTION_CONFIGS[ddi] || null;
  }

  /**
   * Lista todas as jurisdições suportadas
   */
  getSupportedJurisdictions(): JurisdictionConfig[] {
    return this.rules.supportedDDIs
      .map(ddi => JURISDICTION_CONFIGS[ddi])
      .filter(config => config !== undefined);
  }

  /**
   * Valida regras de limite para uma jurisdição
   */
  validateLimitRules(jurisdiction: string): boolean {
    if (!this.rules.limitValidationEnabled) {
      return true;
    }

    const config = this.getJurisdictionConfig(jurisdiction);
    if (!config) {
      this.logger.warn(`Jurisdição não encontrada: ${jurisdiction}`);
      return false;
    }

    return this.isDDISupported(config.ddi);
  }

  /**
   * Verifica se contagem de mensagens está habilitada
   */
  isMessageCountingEnabled(): boolean {
    return this.rules.messageCountingEnabled;
  }

  /**
   * Obtém tipo de controle de limite para jurisdição
   */
  getLimitControlType(jurisdiction: string): 'teams' | 'local' | null {
    const config = this.getJurisdictionConfig(jurisdiction);
    return config?.limitControl || null;
  }

  /**
   * Obtém tipo de banco de dados para jurisdição
   */
  getDatabaseType(jurisdiction: string): 'supabase' | 'mysql' | null {
    const config = this.getJurisdictionConfig(jurisdiction);
    return config?.database || null;
  }

  /**
   * Obtém moeda para jurisdição
   */
  getCurrency(jurisdiction: string): string {
    const config = this.getJurisdictionConfig(jurisdiction);
    return config?.currency || 'BRL';
  }

  /**
   * Formata número de telefone para exibição
   */
  formatPhoneNumber(phoneNumber: string, jurisdiction: string): string {
    const config = this.getJurisdictionConfig(jurisdiction);
    if (!config) {
      return phoneNumber;
    }

    const cleanPhone = phoneNumber.replace(/\D/g, '');
    
    switch (config.jurisdiction) {
      case 'BR':
        // Formato: +55 (11) 99999-9999
        if (cleanPhone.length === 13) {
          return `+${cleanPhone.substring(0, 2)} (${cleanPhone.substring(2, 4)}) ${cleanPhone.substring(4, 9)}-${cleanPhone.substring(9)}`;
        }
        break;
      case 'PT':
        // Formato: +351 999 999 999
        if (cleanPhone.length === 12) {
          return `+${cleanPhone.substring(0, 3)} ${cleanPhone.substring(3, 6)} ${cleanPhone.substring(6, 9)} ${cleanPhone.substring(9)}`;
        }
        break;
      case 'ES':
        // Formato: +34 999 99 99 99
        if (cleanPhone.length === 11) {
          return `+${cleanPhone.substring(0, 2)} ${cleanPhone.substring(2, 5)} ${cleanPhone.substring(5, 7)} ${cleanPhone.substring(7, 9)} ${cleanPhone.substring(9)}`;
        }
        break;
    }

    return phoneNumber;
  }
}

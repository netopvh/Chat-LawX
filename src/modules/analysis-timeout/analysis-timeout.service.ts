import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { TeamsService } from '../teams/teams.service';

@Injectable()
export class AnalysisTimeoutService {
  private readonly logger = new Logger(AnalysisTimeoutService.name);
  
  // Métricas de monitoramento
  private lastExecution: Date | null = null;
  private nextExecution: Date | null = null;
  private totalExecutions = 0;
  private totalErrors = 0;
  private lastError: string | null = null;
  private totalUsersProcessed = 0;
  private totalTimeoutsSent = 0;

  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly teamsService: TeamsService,
  ) {}

  /**
   * Cron job que executa a cada 5 minutos para verificar timeouts de análise
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkAnalysisTimeouts(): Promise<void> {
    const startTime = Date.now();
    this.lastExecution = new Date();
    this.nextExecution = new Date(Date.now() + 5 * 60 * 1000); // Próxima execução em 5 minutos
    this.totalExecutions++;
    
    this.logger.log('🕐 Verificando timeouts de análise de documentos...');
    
    try {
      // Buscar todos os usuários com isInAnalysis = true
      const usersInAnalysis = await this.getUsersInAnalysis();
      
      if (usersInAnalysis.length === 0) {
        this.logger.log('✅ Nenhum usuário em análise de documento');
        const duration = Date.now() - startTime;
        this.logger.log(`⏱️ Execução concluída em ${duration}ms`);
        return;
      }

      this.logger.log(`🔍 Verificando ${usersInAnalysis.length} usuários em análise`);
      this.totalUsersProcessed += usersInAnalysis.length;

      let timeoutsSent = 0;
      for (const user of usersInAnalysis) {
        const timeoutSent = await this.checkUserAnalysisTimeout(user);
        if (timeoutSent) timeoutsSent++;
      }

      this.totalTimeoutsSent += timeoutsSent;
      const duration = Date.now() - startTime;
      
      this.logger.log(`✅ Verificação concluída em ${duration}ms`);
      this.logger.log(`📊 Estatísticas: ${usersInAnalysis.length} usuários verificados, ${timeoutsSent} timeouts enviados`);
      
    } catch (error) {
      this.totalErrors++;
      this.lastError = error.message;
      this.logger.error('❌ Erro ao verificar timeouts de análise:', error);
    }
  }

  /**
   * Busca usuários que estão em análise de documento
   */
  private async getUsersInAnalysis(): Promise<Array<{
    phone: string;
    jurisdiction: string;
    analysisStartTime: number;
  }>> {
    return this.whatsappService.getUsersInAnalysis();
  }

  /**
   * Verifica timeout para um usuário específico
   */
  private async checkUserAnalysisTimeout(user: {
    phone: string;
    jurisdiction: string;
    analysisStartTime: number;
  }): Promise<boolean> {
    try {
      const currentTime = Date.now();
      const timeElapsed = currentTime - user.analysisStartTime;
      const timeoutMs = 10 * 60 * 1000; // 10 minutos

      if (timeElapsed > timeoutMs) {
        this.logger.log(`⏰ Timeout detectado para usuário ${user.phone} (${user.jurisdiction})`);
        
        // Enviar mensagem de timeout
        await this.sendTimeoutMessage(user.phone, user.jurisdiction);
        
        // Limpar estado de análise
        await this.clearAnalysisState(user.phone);
        
        this.logger.log(`✅ Timeout processado para usuário ${user.phone}`);
        return true; // Timeout foi enviado
      }
      
      return false; // Nenhum timeout enviado
    } catch (error) {
      this.logger.error(`❌ Erro ao verificar timeout para usuário ${user.phone}:`, error);
      return false;
    }
  }

  /**
   * Envia mensagem de timeout para o usuário
   */
  private async sendTimeoutMessage(phone: string, jurisdiction: string): Promise<void> {
    try {
      const timeoutMessage = this.getTimeoutMessage(jurisdiction);
      await this.whatsappService.sendMessage(phone, timeoutMessage);
      this.logger.log(`📤 Mensagem de timeout enviada para ${phone}`);
    } catch (error) {
      this.logger.error(`❌ Erro ao enviar mensagem de timeout para ${phone}:`, error);
    }
  }

  /**
   * Limpa o estado de análise do usuário
   */
  private async clearAnalysisState(phone: string): Promise<void> {
    try {
      this.whatsappService.clearAnalysisState(phone);
    } catch (error) {
      this.logger.error(`❌ Erro ao limpar estado de análise para ${phone}:`, error);
    }
  }

  /**
   * Retorna mensagem de timeout baseada na jurisdição
   */
  private getTimeoutMessage(jurisdiction: string): string {
    const messages = {
      'BR': '⏰ Acho que não deseja enviar documento, estou saindo do modo de espera.\n\n📋 Como posso ajudá-lo hoje?',
      'PT': '⏰ Acho que não deseja enviar documento, estou a sair do modo de espera.\n\n📋 Como posso ajudá-lo hoje?',
      'ES': '⏰ Creo que no desea enviar documento, estoy saliendo del modo de espera.\n\n📋 ¿Cómo puedo ayudarle hoy?'
    };

    return messages[jurisdiction] || messages['BR'];
  }

  /**
   * Retorna estatísticas de monitoramento do cron job
   */
  public getCronStats() {
    return {
      lastExecution: this.lastExecution,
      nextExecution: this.nextExecution,
      totalExecutions: this.totalExecutions,
      totalErrors: this.totalErrors,
      lastError: this.lastError,
      totalUsersProcessed: this.totalUsersProcessed,
      totalTimeoutsSent: this.totalTimeoutsSent,
      status: this.totalErrors > 0 ? 'error' : 'healthy',
      uptime: this.lastExecution ? Date.now() - this.lastExecution.getTime() : null
    };
  }

  /**
   * Retorna status de saúde do cron job
   */
  public getHealthStatus() {
    const now = Date.now();
    const lastExec = this.lastExecution?.getTime() || 0;
    const timeSinceLastExecution = now - lastExec;
    
    // Considera saudável se executou nos últimos 15 minutos
    const isHealthy = timeSinceLastExecution < 15 * 60 * 1000;
    
    return {
      status: isHealthy ? 'healthy' : 'unhealthy',
      lastExecution: this.lastExecution,
      timeSinceLastExecution: timeSinceLastExecution,
      totalExecutions: this.totalExecutions,
      totalErrors: this.totalErrors,
      errorRate: this.totalExecutions > 0 ? (this.totalErrors / this.totalExecutions) * 100 : 0
    };
  }
}

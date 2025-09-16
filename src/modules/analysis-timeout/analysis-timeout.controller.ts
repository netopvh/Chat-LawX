import { Controller, Get } from '@nestjs/common';
import { AnalysisTimeoutService } from './analysis-timeout.service';

@Controller('cron-monitoring')
export class AnalysisTimeoutController {
  constructor(private readonly analysisTimeoutService: AnalysisTimeoutService) {}

  /**
   * Retorna estatísticas detalhadas do cron job de timeout
   */
  @Get('analysis-timeout/stats')
  getAnalysisTimeoutStats() {
    return this.analysisTimeoutService.getCronStats();
  }

  /**
   * Retorna status de saúde do cron job de timeout
   */
  @Get('analysis-timeout/health')
  getAnalysisTimeoutHealth() {
    return this.analysisTimeoutService.getHealthStatus();
  }

  /**
   * Retorna resumo de todos os cron jobs
   */
  @Get('summary')
  getCronSummary() {
    const stats = this.analysisTimeoutService.getCronStats();
    const health = this.analysisTimeoutService.getHealthStatus();
    
    return {
      analysisTimeout: {
        stats,
        health,
        description: 'Verifica timeouts de análise de documentos a cada 5 minutos'
      },
      summary: {
        totalCronJobs: 1,
        healthyJobs: health.status === 'healthy' ? 1 : 0,
        unhealthyJobs: health.status === 'unhealthy' ? 1 : 0,
        lastCheck: new Date().toISOString()
      }
    };
  }
}

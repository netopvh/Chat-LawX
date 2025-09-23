import { Injectable, Logger } from '@nestjs/common';
import { AiService } from '../../../ai/ai.service';
import { IAIGateway } from '../../interfaces/ai-gateway.interface';

@Injectable()
export class AIGateway implements IAIGateway {
  private readonly logger = new Logger(AIGateway.name);

  constructor(private readonly aiService: AiService) {}

  async executeCustomPrompt(
    prompt: string,
    model: 'gpt-4o' | 'gpt-3.5-turbo' | 'gpt-4' | 'gemini-1.5-flash' | 'gemini-1.5-pro' = 'gpt-3.5-turbo',
    system: string = 'Você é um assistente útil.',
    temperature: number = 0.7,
    maxTokens: number = 300
  ): Promise<string> {
    try {
      // Nesta fase, apenas delega. Próximas fases adicionam timeout/retry/circuit breaker.
      return await this.aiService.executeCustomPrompt(prompt, model, system, temperature, maxTokens);
    } catch (error) {
      this.logger.error('Erro ao executar prompt customizado:', error);
      throw error;
    }
  }
}



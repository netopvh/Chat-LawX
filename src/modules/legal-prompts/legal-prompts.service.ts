import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LegalPrompt, CreateLegalPromptDto, UpdateLegalPromptDto, LegalPromptQueryOptions } from './interfaces/legal-prompt.interface';

@Injectable()
export class LegalPromptsService {
  private readonly logger = new Logger(LegalPromptsService.name);

  constructor(private prismaService: PrismaService) {}

  /**
   * Cria um novo prompt legal
   */
  async createPrompt(createDto: CreateLegalPromptDto): Promise<LegalPrompt> {
    try {
      const prompt = await this.prismaService.legalPrompt.create({
        data: {
          jurisdiction: createDto.jurisdiction,
          name: createDto.name,
          description: createDto.description,
          content: createDto.content,
          isActive: createDto.isActive ?? true,
        },
      });

      this.logger.log(`Prompt legal criado: ${prompt.id} - ${prompt.name}`);
      return prompt;
    } catch (error) {
      this.logger.error('Erro ao criar prompt legal:', error);
      throw error;
    }
  }

  /**
   * Busca um prompt por ID
   */
  async getPromptById(id: string): Promise<LegalPrompt | null> {
    try {
      const prompt = await this.prismaService.legalPrompt.findUnique({
        where: { id },
      });

      if (!prompt) {
        this.logger.warn(`Prompt não encontrado: ${id}`);
        return null;
      }

      return prompt;
    } catch (error) {
      this.logger.error(`Erro ao buscar prompt ${id}:`, error);
      throw error;
    }
  }

  /**
   * Lista prompts com filtros
   */
  async getPrompts(options: LegalPromptQueryOptions = {}): Promise<LegalPrompt[]> {
    try {
      const where: any = {};

      if (options.jurisdiction) {
        where.jurisdiction = options.jurisdiction;
      }

      if (options.isActive !== undefined) {
        where.isActive = options.isActive;
      }

      const prompts = await this.prismaService.legalPrompt.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: options.limit || 50,
        skip: options.offset || 0,
      });

      this.logger.log(`Encontrados ${prompts.length} prompts`);
      return prompts;
    } catch (error) {
      this.logger.error('Erro ao listar prompts:', error);
      throw error;
    }
  }

  /**
   * Busca prompt ativo por jurisdição
   */
  async getActivePromptByJurisdiction(jurisdiction: string): Promise<LegalPrompt | null> {
    try {
      const prompt = await this.prismaService.legalPrompt.findFirst({
        where: {
          jurisdiction,
          isActive: true,
        },
        orderBy: { updatedAt: 'desc' },
      });

      if (!prompt) {
        this.logger.warn(`Nenhum prompt ativo encontrado para jurisdição: ${jurisdiction}`);
        return null;
      }

      this.logger.log(`Prompt ativo encontrado para ${jurisdiction}: ${prompt.name}`);
      return prompt;
    } catch (error) {
      this.logger.error(`Erro ao buscar prompt ativo para ${jurisdiction}:`, error);
      throw error;
    }
  }

  /**
   * Atualiza um prompt
   */
  async updatePrompt(id: string, updateDto: UpdateLegalPromptDto): Promise<LegalPrompt> {
    try {
      const prompt = await this.prismaService.legalPrompt.update({
        where: { id },
        data: {
          ...updateDto,
          updatedAt: new Date(),
        },
      });

      this.logger.log(`Prompt atualizado: ${id}`);
      return prompt;
    } catch (error) {
      this.logger.error(`Erro ao atualizar prompt ${id}:`, error);
      throw error;
    }
  }

  /**
   * Remove um prompt (soft delete)
   */
  async deletePrompt(id: string): Promise<void> {
    try {
      await this.prismaService.legalPrompt.update({
        where: { id },
        data: { isActive: false },
      });

      this.logger.log(`Prompt desativado: ${id}`);
    } catch (error) {
      this.logger.error(`Erro ao desativar prompt ${id}:`, error);
      throw error;
    }
  }

  /**
   * Inicializa prompts padrão para cada jurisdição
   */
  async initializeDefaultPrompts(): Promise<void> {
    try {
      const defaultPrompts = [
        {
          jurisdiction: 'BR',
          name: 'Assistente Jurídico Brasil',
          description: 'Prompt para consultas jurídicas no Brasil',
          content: `Você é um assistente jurídico especializado em legislação brasileira. 
            Forneça respostas precisas baseadas na legislação vigente no Brasil, 
            incluindo Código Civil, Código Penal, CLT, Constituição Federal e outras leis aplicáveis.
            Sempre mencione que suas respostas são informativas e não substituem consulta jurídica profissional.`,
        },
        {
          jurisdiction: 'PT',
          name: 'Assistente Jurídico Portugal',
          description: 'Prompt para consultas jurídicas em Portugal',
          content: `Você é um assistente jurídico especializado em legislação portuguesa.
            Forneça respostas precisas baseadas na legislação vigente em Portugal,
            incluindo Código Civil, Código Penal, Código do Trabalho e outras leis aplicáveis.
            Sempre mencione que suas respostas são informativas e não substituem consulta jurídica profissional.`,
        },
        {
          jurisdiction: 'ES',
          name: 'Assistente Jurídico Espanha',
          description: 'Prompt para consultas jurídicas na Espanha',
          content: `Você é um assistente jurídico especializado em legislação espanhola.
            Forneça respostas precisas baseadas na legislação vigente na Espanha,
            incluindo Código Civil, Código Penal, Estatuto de los Trabajadores e outras leis aplicáveis.
            Sempre mencione que suas respostas são informativas e não substituem consulta jurídica profissional.`,
        },
      ];

      for (const promptData of defaultPrompts) {
        const existingPrompt = await this.getActivePromptByJurisdiction(promptData.jurisdiction);
        
        if (!existingPrompt) {
          await this.createPrompt(promptData);
          this.logger.log(`Prompt padrão criado para ${promptData.jurisdiction}`);
        }
      }

      this.logger.log('Prompts padrão inicializados com sucesso');
    } catch (error) {
      this.logger.error('Erro ao inicializar prompts padrão:', error);
      throw error;
    }
  }
}
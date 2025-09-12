import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  LegalPrompt,
  CreateLegalPromptDto,
  UpdateLegalPromptDto,
  LegalPromptQueryOptions,
  Conversation,
  CreateConversationDto,
  UpdateConversationDto,
  ConversationMessage,
  OpenAIRequest,
  OpenAIResponse,
} from './interfaces/legal-prompt.interface';

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
   * Cria uma nova conversa
   */
  async createConversation(createDto: CreateConversationDto): Promise<Conversation> {
    try {
      const conversation = await this.prismaService.conversation.create({
        data: {
          userId: createDto.userId,
          promptId: createDto.promptId,
          previousResponseId: createDto.previousResponseId,
          openaiThreadId: createDto.openaiThreadId,
          jurisdiction: createDto.jurisdiction,
          messages: createDto.initialMessage ? [createDto.initialMessage] : [] as any,
        },
      });

      this.logger.log(`Conversa criada: ${conversation.id}`);
      return {
        ...conversation,
        messages: conversation.messages as unknown as ConversationMessage[],
      } as Conversation;
    } catch (error) {
      this.logger.error('Erro ao criar conversa:', error);
      throw error;
    }
  }

  /**
   * Busca conversa ativa por usuário e jurisdição
   */
  async getActiveConversationByUser(userId: string, jurisdiction: string): Promise<Conversation | null> {
    try {
      const conversation = await this.prismaService.conversation.findFirst({
        where: {
          userId,
          jurisdiction,
          status: 'active',
        },
        orderBy: { updatedAt: 'desc' },
        include: {
          prompt: true,
        },
      });

      if (!conversation) {
        this.logger.log(`Nenhuma conversa ativa encontrada para usuário ${userId} em ${jurisdiction}`);
        return null;
      }

      return {
        ...conversation,
        messages: conversation.messages as unknown as ConversationMessage[],
        prompt: conversation.prompt,
      } as Conversation;
    } catch (error) {
      this.logger.error(`Erro ao buscar conversa ativa para usuário ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Prepara requisição para OpenAI com contexto da conversa
   */
  async prepareOpenAIRequest(
    conversation: Conversation,
    userMessage: string
  ): Promise<OpenAIRequest> {
    try {
      // Buscar o prompt associado à conversa
      const prompt = await this.getPromptById(conversation.promptId);
      if (!prompt) {
        throw new Error('Prompt não encontrado para a conversa');
      }

      const systemMessage = {
        role: 'system' as const,
        content: prompt.content,
      };

      const conversationMessages = conversation.messages.map(msg => ({
        role: msg.role,
        content: msg.content,
      }));

      const newUserMessage = {
        role: 'user' as const,
        content: userMessage,
      };

      const messages = [systemMessage, ...conversationMessages, newUserMessage];

      const request: OpenAIRequest = {
        model: 'gpt-4o-2024-08-06',
        messages,
        temperature: 0.7,
        max_tokens: 2000,
      };

      // Adicionar previous_response_id se disponível
      if (conversation.previousResponseId) {
        request.previous_response_id = conversation.previousResponseId;
      }

      // Adicionar response_format para saídas estruturadas se necessário
      if (conversation.jurisdiction === 'BR') {
        request.response_format = {
          type: 'json_schema',
          json_schema: {
            name: 'legal_response_br',
            schema: {
              type: 'object',
              properties: {
                resposta: { type: 'string' },
                referencias: {
                  type: 'array',
                  items: { type: 'string' }
                },
                sugestoes: {
                  type: 'array',
                  items: { type: 'string' }
                }
              },
              required: ['resposta']
            },
            strict: false
          }
        };
      }

      return request;
    } catch (error) {
      this.logger.error('Erro ao preparar requisição OpenAI:', error);
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
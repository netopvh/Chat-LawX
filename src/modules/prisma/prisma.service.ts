import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: ['query', 'info', 'warn', 'error'],
    });
  }

  async onModuleInit() {
    try {
      await this.$connect();
      this.logger.log('✅ Conectado ao banco de dados MySQL via Prisma');
    } catch (error) {
      this.logger.error('❌ Erro ao conectar ao banco de dados:', error);
      throw error;
    }
  }

  async onModuleDestroy() {
    try {
      await this.$disconnect();
      this.logger.log('🔌 Desconectado do banco de dados MySQL');
    } catch (error) {
      this.logger.error('❌ Erro ao desconectar do banco de dados:', error);
    }
  }

  async enableShutdownHooks(app: any) {
    process.on('beforeExit', async () => {
      await app.close();
    });
  }

  // Métodos específicos para Chat LawX
  async findUserByPhone(phone: string) {
    return this.user.findUnique({
      where: { phone },
      include: {
        legalDocuments: true,
        usage: true,
      },
    });
  }

  async findUserByDDI(ddi: string) {
    return this.user.findMany({
      where: { ddi },
      include: {
        legalDocuments: true,
        usage: true,
      },
    });
  }

  async incrementUserMessages(userId: string) {
    return this.user.update({
      where: { id: userId },
      data: {
        messagesCount: {
          increment: 1,
        },
      },
    });
  }

  async createUsageRecord(userId: string, jurisdiction: string) {
    return this.usage.create({
      data: {
        userId,
        jurisdiction,
        messagesCount: 1,
      },
    });
  }

  async updateUsageRecord(usageId: string) {
    return this.usage.update({
      where: { id: usageId },
      data: {
        messagesCount: {
          increment: 1,
        },
        updatedAt: new Date(),
      },
    });
  }

  async getUsageByUser(userId: string) {
    return this.usage.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getUsageByJurisdiction(jurisdiction: string) {
    return this.usage.findMany({
      where: { jurisdiction },
      include: {
        user: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Métodos para Legal Prompts
  async findActivePromptByJurisdiction(jurisdiction: string) {
    return this.legalPrompt.findFirst({
      where: {
        jurisdiction,
        isActive: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async findActiveConversationByUser(userId: string, jurisdiction: string) {
    return this.conversation.findFirst({
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
  }

  async createConversation(data: {
    userId: string;
    promptId: string;
    previousResponseId?: string;
    openaiThreadId?: string;
    jurisdiction: string;
    messages?: any[];
  }) {
    return this.conversation.create({
      data: {
        userId: data.userId,
        promptId: data.promptId,
        previousResponseId: data.previousResponseId,
        openaiThreadId: data.openaiThreadId,
        jurisdiction: data.jurisdiction,
        messages: data.messages || [],
      },
    });
  }

  async updateConversation(id: string, data: {
    previousResponseId?: string;
    openaiThreadId?: string;
    openaiResponseId?: string;
    messages?: any[];
    status?: string;
  }) {
    return this.conversation.update({
      where: { id },
      data: {
        ...data,
        updatedAt: new Date(),
      },
    });
  }
}

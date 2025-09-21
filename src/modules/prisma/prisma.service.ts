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
      },
    });
  }

  async findUserByDDI(ddi: string) {
    return this.user.findMany({
      where: { ddi },
      include: {
        legalDocuments: true,
      },
    });
  }

  async incrementUserMessages(userId: string) {
    // Este método agora é apenas um placeholder
    // O incremento real é feito no UsageTracking
    this.logger.log(`📈 Incremento de mensagem para usuário: ${userId} (processado via UsageTracking)`);
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

  // Métodos para WhatsApp Sessions
  async findWhatsAppSessionByPhone(phone: string) {
    return this.whatsAppSession.findUnique({
      where: { phone },
      include: {
        user: true,
        messages: true,
      },
    });
  }

  async createWhatsAppSession(data: {
    phone: string;
    name: string;
    jurisdiction: string;
    ddi: string;
  }) {
    return this.whatsAppSession.create({
      data: {
        phone: data.phone,
        name: data.name,
        jurisdiction: data.jurisdiction,
        ddi: data.ddi,
        lastMessageSent: new Date(),
        isActive: true,
      },
    });
  }

  async updateWhatsAppSession(phone: string, data: {
    lastMessageSent?: Date;
    isActive?: boolean;
  }) {
    return this.whatsAppSession.update({
      where: { phone },
      data: {
        ...data,
        updatedAt: new Date(),
      },
    });
  }

  async updateUserLastWhatsAppInteraction(phone: string) {
    return this.user.update({
      where: { phone },
      data: {
        lastWhatsAppInteraction: new Date(),
      },
    });
  }

  // Métodos para Assinaturas
  async createFremiumSubscription(userId: string, jurisdiction: string) {
    try {
      this.logger.log(`🎁 Criando assinatura Fremium para usuário: ${userId} (${jurisdiction})`);
      
      // Buscar plano Fremium
      const fremiumPlan = await this.plan.findFirst({
        where: {
          name: 'Fremium',
          isActive: true,
          jurisdiction: jurisdiction
        }
      });

      if (!fremiumPlan) {
        this.logger.error(`❌ Plano Fremium não encontrado para jurisdição: ${jurisdiction}`);
        throw new Error(`Plano Fremium não encontrado para ${jurisdiction}`);
      }

      // Calcular datas do período
      const now = new Date();
      const periodEnd = new Date(now);
      periodEnd.setMonth(periodEnd.getMonth() + 1); // 1 mês

      // Criar assinatura Fremium
      const subscription = await this.subscription.create({
        data: {
          userId: userId,
          planId: fremiumPlan.id,
          status: 'active',
          billingCycle: 'monthly',
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          jurisdiction: jurisdiction,
          syncStatus: 'synced'
        }
      });

      // Criar registro de uso inicial para o período da assinatura
      await this.findOrCreateUsageTracking(
        userId,
        subscription.id,
        now,
        periodEnd,
        jurisdiction
      );

      this.logger.log(`✅ Assinatura Fremium criada com sucesso: ${subscription.id}`);
      this.logger.log(`📊 Registro de uso criado para período: ${now.toISOString()} - ${periodEnd.toISOString()}`);
      return subscription;
    } catch (error) {
      this.logger.error(`❌ Erro ao criar assinatura Fremium para usuário ${userId}:`, error);
      throw error;
    }
  }

  async findUserSubscription(userId: string) {
    return this.subscription.findFirst({
      where: {
        userId: userId,
        status: 'active'
      },
      include: {
        plan: true
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
  }

  async findFremiumPlan(jurisdiction: string) {
    return this.plan.findFirst({
      where: {
        name: 'Fremium',
        isActive: true,
        jurisdiction: jurisdiction
      }
    });
  }

  async findOrCreateUsageTracking(
    userId: string, 
    subscriptionId: string, 
    periodStart: Date, 
    periodEnd: Date, 
    jurisdiction: string
  ) {
    try {
      // Buscar registro de uso existente para o período
      let usageTracking = await this.usageTracking.findFirst({
        where: {
          userId: userId,
          subscriptionId: subscriptionId,
          periodStart: periodStart,
          periodEnd: periodEnd
        }
      });

      // Se não existir, criar novo registro
      if (!usageTracking) {
        this.logger.log(`📊 Criando novo registro de uso para usuário: ${userId} (período: ${periodStart.toISOString()} - ${periodEnd.toISOString()})`);
        
        usageTracking = await this.usageTracking.create({
          data: {
            userId: userId,
            subscriptionId: subscriptionId,
            periodStart: periodStart,
            periodEnd: periodEnd,
            jurisdiction: jurisdiction,
            messagesCount: 0,
            consultationsCount: 0,
            documentAnalysisCount: 0
          }
        });
        
        this.logger.log(`✅ Registro de uso criado: ${usageTracking.id}`);
      }

      return usageTracking;
    } catch (error) {
      this.logger.error(`❌ Erro ao buscar/criar registro de uso para usuário ${userId}:`, error);
      throw error;
    }
  }

  // Métodos para Verificação de Limites (ES/PT)
  async validateUserLimits(userId: string, jurisdiction: string): Promise<{
    isValid: boolean;
    currentUsage: number;
    limit: number;
    remaining: number;
    message: string;
  }> {
    try {
      this.logger.log(`🔍 Validando limites para usuário: ${userId} (${jurisdiction})`);
      
      // Buscar assinatura ativa do usuário
      const subscription = await this.findUserSubscription(userId);
      
      if (!subscription) {
        this.logger.error(`❌ Nenhuma assinatura ativa encontrada para usuário: ${userId}`);
        return {
          isValid: false,
          currentUsage: 0,
          limit: 0,
          remaining: 0,
          message: 'Nenhuma assinatura ativa encontrada'
        };
      }

      // Buscar plano para obter limites
      const plan = subscription.plan;
      
      if (!plan) {
        this.logger.error(`❌ Plano não encontrado para assinatura: ${subscription.id}`);
        return {
          isValid: false,
          currentUsage: 0,
          limit: 0,
          remaining: 0,
          message: 'Plano não encontrado'
        };
      }

      // Buscar ou criar registro de uso para o período atual da assinatura
      const usageTracking = await this.findOrCreateUsageTracking(
        userId, 
        subscription.id, 
        subscription.currentPeriodStart, 
        subscription.currentPeriodEnd, 
        jurisdiction
      );

      const currentUsage = usageTracking.messagesCount;
      const limit = plan.messageLimit || 0;
      const remaining = Math.max(0, limit - currentUsage);
      const isValid = currentUsage < limit;

      this.logger.log(`📊 Limites do usuário ${userId}: ${currentUsage}/${limit} (${remaining} restantes)`);

      return {
        isValid,
        currentUsage,
        limit,
        remaining,
        message: isValid ? 'Limite válido' : 'Limite excedido'
      };

    } catch (error) {
      this.logger.error(`❌ Erro ao validar limites para usuário ${userId}:`, error);
      return {
        isValid: false,
        currentUsage: 0,
        limit: 0,
        remaining: 0,
        message: 'Erro ao validar limites'
      };
    }
  }

  async incrementUserMessageCount(userId: string): Promise<void> {
    try {
      // Buscar assinatura ativa do usuário
      const subscription = await this.findUserSubscription(userId);
      
      if (!subscription) {
        this.logger.error(`❌ Nenhuma assinatura ativa encontrada para incrementar uso: ${userId}`);
        return;
      }

      // Buscar ou criar registro de uso para o período atual
      const usageTracking = await this.findOrCreateUsageTracking(
        userId,
        subscription.id,
        subscription.currentPeriodStart,
        subscription.currentPeriodEnd,
        subscription.jurisdiction || 'PT' // fallback
      );

      // Incrementar contador de mensagens no registro de uso
      await this.usageTracking.update({
        where: { id: usageTracking.id },
        data: {
          messagesCount: {
            increment: 1
          }
        }
      });

      this.logger.log(`📈 Contador de mensagens incrementado para usuário: ${userId} (uso: ${usageTracking.messagesCount + 1})`);
    } catch (error) {
      this.logger.error(`❌ Erro ao incrementar contador de mensagens para usuário ${userId}:`, error);
    }
  }
}

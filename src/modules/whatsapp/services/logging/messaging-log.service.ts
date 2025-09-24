import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class MessagingLogService {
  private readonly logger = new Logger(MessagingLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  private normalizePhone(phone: string): string {
    return (phone || '').replace(/\D/g, '');
  }

  async logInboundText(params: { sessionId: string; phone: string; jurisdiction: string; text: string; }): Promise<void> {
    try {
      await (this.prisma as any).whatsAppMessage.create({
        data: {
          sessionId: params.sessionId,
          phone: this.normalizePhone(params.phone),
          jurisdiction: params.jurisdiction,
          messageType: 'text',
          direction: 'inbound',
          role: 'user',
          content: params.text,
        },
      });
    } catch (error) {
      this.logger.error('Erro ao logar inbound text:', error);
    }
  }

  async logInboundMedia(params: { sessionId: string; phone: string; jurisdiction: string; messageType: 'audio'|'image'|'document'; url: string; json?: any; }): Promise<void> {
    try {
      await (this.prisma as any).whatsAppMessage.create({
        data: {
          sessionId: params.sessionId,
          phone: this.normalizePhone(params.phone),
          jurisdiction: params.jurisdiction,
          messageType: params.messageType,
          direction: 'inbound',
          role: 'user',
          contentUrl: params.url,
          contentJson: params.json,
        },
      });
    } catch (error) {
      this.logger.error('Erro ao logar inbound media:', error);
    }
  }

  async logOutboundText(params: { sessionId: string; phone: string; jurisdiction: string; text: string; model?: string; tokens?: number; role?: 'assistant'|'system'; replyToId?: string; json?: any; }): Promise<void> {
    try {
      await (this.prisma as any).whatsAppMessage.create({
        data: {
          sessionId: params.sessionId,
          phone: this.normalizePhone(params.phone),
          jurisdiction: params.jurisdiction,
          messageType: 'text',
          direction: 'outbound',
          role: params.role || 'assistant',
          content: params.text,
          contentJson: params.json,
          model: params.model,
          tokenCount: params.tokens,
          replyToId: params.replyToId,
        },
      });
    } catch (error) {
      this.logger.error('Erro ao logar outbound text:', error);
    }
  }

  async logOutboundMedia(params: { sessionId: string; phone: string; jurisdiction: string; messageType: 'audio'|'image'|'document'; url: string; model?: string; tokens?: number; role?: 'assistant'|'system'; replyToId?: string; json?: any; }): Promise<void> {
    try {
      await (this.prisma as any).whatsAppMessage.create({
        data: {
          sessionId: params.sessionId,
          phone: this.normalizePhone(params.phone),
          jurisdiction: params.jurisdiction,
          messageType: params.messageType,
          direction: 'outbound',
          role: params.role || 'assistant',
          contentUrl: params.url,
          contentJson: params.json,
          model: params.model,
          tokenCount: params.tokens,
          replyToId: params.replyToId,
        },
      });
    } catch (error) {
      this.logger.error('Erro ao logar outbound media:', error);
    }
  }
}



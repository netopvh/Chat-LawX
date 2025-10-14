import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class MessagingLogService {
  private readonly logger = new Logger(MessagingLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  private normalizePhone(phone: string): string {
    return (phone || '').replace(/\D/g, '');
  }

  async backfillConversationId(params: { phone: string; conversationId: string; sinceMinutes?: number }): Promise<void> {
    try {
      const minutes = params.sinceMinutes ?? 60;
      const since = new Date(Date.now() - minutes * 60 * 1000);
      await (this.prisma as any).whatsAppMessage.updateMany({
        where: {
          phone: this.normalizePhone(params.phone),
          conversationId: null,
          createdAt: { gte: since },
        },
        data: {
          conversationId: params.conversationId,
        },
      });
    } catch (error) {
      this.logger.error('Erro ao fazer backfill de conversationId:', error);
    }
  }

  async fetchHistory(params: {
    phone?: string;
    sessionId?: string;
    conversationId?: string;
    jurisdiction?: string;
    since?: string;
    until?: string;
    limit?: number;
  }): Promise<Array<{ id: string; sessionId: string; phone: string; messageType: string; content?: string | null; contentUrl?: string | null; contentJson?: any; direction: string; role: string; model?: string | null; tokenCount?: number | null; replyToId?: string | null; conversationId?: string | null; jurisdiction: string; createdAt: Date }>> {
    const where: any = {};
    if (params.sessionId) where.sessionId = params.sessionId;
    if (params.phone) where.phone = this.normalizePhone(params.phone);
    if (params.conversationId) where.conversationId = params.conversationId;
    if (params.jurisdiction) where.jurisdiction = params.jurisdiction;
    if (params.since || params.until) {
      where.createdAt = {};
      if (params.since) where.createdAt.gte = new Date(params.since);
      if (params.until) where.createdAt.lte = new Date(params.until);
    }

    const take = Math.min(Math.max(params.limit ?? 200, 1), 1000);

    const rows = await (this.prisma as any).whatsAppMessage.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take,
    });

    return rows as any;
  }

  async listConversations(params: {
    phone?: string;
    jurisdiction?: string;
    since?: string;
    until?: string;
    limit?: number;
  }): Promise<Array<{
    sessionId: string;
    conversationId: string | null;
    phone: string;
    name: string | null;
    jurisdiction: string;
    lastMessageAt: Date;
    messagesCount: number;
  }>> {
    const where: any = {};
    if (params.phone) where.phone = this.normalizePhone(params.phone);
    if (params.jurisdiction) where.jurisdiction = params.jurisdiction;
    if (params.since || params.until) {
      where.createdAt = {};
      if (params.since) where.createdAt.gte = new Date(params.since);
      if (params.until) where.createdAt.lte = new Date(params.until);
    }

    const take = Math.min(Math.max(params.limit ?? 100, 1), 500);

    const groups = await (this.prisma as any).whatsAppMessage.groupBy({
      by: ['sessionId', 'phone', 'conversationId', 'jurisdiction'],
      where,
      _max: { createdAt: true },
      _count: { _all: true },
      orderBy: { _max: { createdAt: 'desc' } },
      take,
    });

    const sessionIds = Array.from(new Set(groups.map((g: any) => g.sessionId)));
    const sessions = await (this.prisma as any).whatsAppSession.findMany({
      where: { id: { in: sessionIds } },
      select: { id: true, name: true },
    });
    const sessionIdToName = new Map<string, string>();
    for (const s of sessions) sessionIdToName.set(s.id, s.name);

    return groups.map((g: any) => ({
      sessionId: g.sessionId,
      conversationId: g.conversationId,
      phone: g.phone,
      name: sessionIdToName.get(g.sessionId) || null,
      jurisdiction: g.jurisdiction,
      lastMessageAt: g._max.createdAt,
      messagesCount: g._count._all,
    }));
  }

  async logInboundText(params: { sessionId: string; phone: string; jurisdiction: string; text: string; conversationId?: string; }): Promise<void> {
    try {
      await (this.prisma as any).whatsAppMessage.create({
        data: {
          sessionId: params.sessionId,
          phone: this.normalizePhone(params.phone),
          jurisdiction: params.jurisdiction,
          conversationId: params.conversationId,
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

  async logInboundMedia(params: { sessionId: string; phone: string; jurisdiction: string; messageType: 'audio'|'image'|'document'; url: string; conversationId?: string; json?: any; }): Promise<void> {
    try {
      await (this.prisma as any).whatsAppMessage.create({
        data: {
          sessionId: params.sessionId,
          phone: this.normalizePhone(params.phone),
          jurisdiction: params.jurisdiction,
          conversationId: params.conversationId,
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

  async logOutboundText(params: { sessionId: string; phone: string; jurisdiction: string; text: string; conversationId?: string; model?: string; tokens?: number; role?: 'assistant'|'system'; replyToId?: string; json?: any; }): Promise<void> {
    try {
      await (this.prisma as any).whatsAppMessage.create({
        data: {
          sessionId: params.sessionId,
          phone: this.normalizePhone(params.phone),
          jurisdiction: params.jurisdiction,
          conversationId: params.conversationId,
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

  async logOutboundMedia(params: { sessionId: string; phone: string; jurisdiction: string; messageType: 'audio'|'image'|'document'; url: string; conversationId?: string; model?: string; tokens?: number; role?: 'assistant'|'system'; replyToId?: string; json?: any; }): Promise<void> {
    try {
      await (this.prisma as any).whatsAppMessage.create({
        data: {
          sessionId: params.sessionId,
          phone: this.normalizePhone(params.phone),
          jurisdiction: params.jurisdiction,
          conversationId: params.conversationId,
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



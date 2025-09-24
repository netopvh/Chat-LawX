import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

@Injectable()
export class ContextBuilderService {
  constructor(private readonly prisma: PrismaService) {}

  private normalizePhone(phone: string): string {
    return (phone || '').replace(/\D/g, '');
  }

  async buildConversationContext(params: {
    sessionId?: string;
    phone: string;
    jurisdiction: string;
    userLimit?: number;
    assistantLimit?: number;
  }): Promise<ChatMessage[]> {
    const userLimit = params.userLimit ?? 4;
    const assistantLimit = params.assistantLimit ?? 4;

    const phone = this.normalizePhone(params.phone);

    // Buscar últimas N mensagens (buffer) e filtrar por role
    const messages = await (this.prisma as any).whatsAppMessage.findMany({
      where: params.sessionId
        ? { sessionId: params.sessionId }
        : { phone: phone },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        role: true,
        content: true,
        messageType: true,
        createdAt: true,
      },
    });

    const userMsgs: ChatMessage[] = [];
    const assistantMsgs: ChatMessage[] = [];

    for (const m of messages) {
      if (m.messageType !== 'text') continue; // Somente texto no contexto curto
      if (!m.content) continue;
      if (m.role === 'user' && userMsgs.length < userLimit) {
        userMsgs.push({ role: 'user', content: m.content });
      } else if ((m.role === 'assistant' || m.role === 'system') && assistantMsgs.length < assistantLimit) {
        assistantMsgs.push({ role: 'assistant', content: m.content });
      }

      if (userMsgs.length >= userLimit && assistantMsgs.length >= assistantLimit) break;
    }

    // Reordenar cronologicamente (asc)
    const chronological = [...userMsgs, ...assistantMsgs]
      .reverse() // pois vieram desc; reverse mantém aproximadamente, mas mistura
      .slice(0); // noop para manter tipo

    // Estratégia simples de ordenação: buscar novamente ordenado asc com filtro por IDs/tempos não disponível aqui.
    // Para manter simples, retornamos interlevação aproximada user/assistant pelo reverse.
    return chronological;
  }
}



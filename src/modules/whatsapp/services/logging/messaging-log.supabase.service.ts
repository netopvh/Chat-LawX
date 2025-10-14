import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../../supabase/supabase.service';

interface BaseLogParams {
  phone: string;
  jurisdiction: string; // esperado 'BR'
  conversationId?: string | null;
  sessionExternalId?: string | null;
}

@Injectable()
export class MessagingLogSupabaseService {
  private readonly logger = new Logger(MessagingLogSupabaseService.name);

  constructor(private readonly supabase: SupabaseService) {}

  private normalizePhone(phone: string): string {
    const digits = (phone || '').replace(/\D/g, '');
    if (digits.startsWith('55')) return digits.slice(2);
    return digits;
  }

  async logInboundText(params: BaseLogParams & { text: string }): Promise<void> {
    try {
      const client = this.supabase.getClient();
      await client.from('whatsapp_messages_br').insert({
        phone: this.normalizePhone(params.phone),
        jurisdiction: params.jurisdiction || 'BR',
        conversation_id: params.conversationId || null,
        session_external_id: params.sessionExternalId || null,
        direction: 'inbound',
        role: 'user',
        message_type: 'text',
        content: params.text,
      });
    } catch (error) {
      this.logger.error('Erro ao logar inbound text (Supabase BR):', error);
    }
  }

  async logOutboundText(params: BaseLogParams & { text: string; role?: 'assistant' | 'system'; model?: string; tokens?: number; json?: any }): Promise<void> {
    try {
      const client = this.supabase.getClient();
      await client.from('whatsapp_messages_br').insert({
        phone: this.normalizePhone(params.phone),
        jurisdiction: params.jurisdiction || 'BR',
        conversation_id: params.conversationId || null,
        session_external_id: params.sessionExternalId || null,
        direction: 'outbound',
        role: params.role || 'assistant',
        message_type: 'text',
        content: params.text,
        content_json: params.json || null,
        model: params.model || null,
        token_count: params.tokens || null,
      });
    } catch (error) {
      this.logger.error('Erro ao logar outbound text (Supabase BR):', error);
    }
  }

  async logInboundMedia(params: BaseLogParams & { messageType: 'audio' | 'image' | 'document'; url: string; json?: any }): Promise<void> {
    try {
      const client = this.supabase.getClient();
      await client.from('whatsapp_messages_br').insert({
        phone: this.normalizePhone(params.phone),
        jurisdiction: params.jurisdiction || 'BR',
        conversation_id: params.conversationId || null,
        session_external_id: params.sessionExternalId || null,
        direction: 'inbound',
        role: 'user',
        message_type: params.messageType,
        content_url: params.url,
        content_json: params.json || null,
      });
    } catch (error) {
      this.logger.error('Erro ao logar inbound media (Supabase BR):', error);
    }
  }

  async logOutboundMedia(params: BaseLogParams & { messageType: 'audio' | 'image' | 'document'; url: string; json?: any; model?: string; tokens?: number; role?: 'assistant' | 'system' }): Promise<void> {
    try {
      const client = this.supabase.getClient();
      await client.from('whatsapp_messages_br').insert({
        phone: this.normalizePhone(params.phone),
        jurisdiction: params.jurisdiction || 'BR',
        conversation_id: params.conversationId || null,
        session_external_id: params.sessionExternalId || null,
        direction: 'outbound',
        role: params.role || 'assistant',
        message_type: params.messageType,
        content_url: params.url,
        content_json: params.json || null,
        model: params.model || null,
        token_count: params.tokens || null,
      });
    } catch (error) {
      this.logger.error('Erro ao logar outbound media (Supabase BR):', error);
    }
  }

  async fetchHistory(params: { phone?: string; conversationId?: string; since?: string; until?: string; limit?: number }): Promise<any[]> {
    try {
      const client = this.supabase.getClient();
      let query = client.from('whatsapp_messages_br').select('*').order('created_at', { ascending: true });
      if (params.phone) query = query.eq('phone', this.normalizePhone(params.phone));
      if (params.conversationId) query = query.eq('conversation_id', params.conversationId);
      if (params.since) query = query.gte('created_at', params.since);
      if (params.until) query = query.lte('created_at', params.until);
      if (params.limit) query = query.limit(Math.min(Math.max(params.limit, 1), 1000));
      const { data } = await query;
      return data || [];
    } catch (error) {
      this.logger.error('Erro ao buscar histórico (Supabase BR):', error);
      return [];
    }
  }

  async listConversations(params: { phone?: string; since?: string; until?: string; limit?: number }): Promise<any[]> {
    try {
      const client = this.supabase.getClient();
      let query = client
        .from('whatsapp_messages_br')
        .select('conversation_id, phone, jurisdiction, created_at')
        .order('created_at', { ascending: false });
      if (params.phone) query = query.eq('phone', this.normalizePhone(params.phone));
      if (params.since) query = query.gte('created_at', params.since);
      if (params.until) query = query.lte('created_at', params.until);
      if (params.limit) query = query.limit(Math.min(Math.max(params.limit, 1), 500));
      const { data } = await query;
      // Agrupar em memória por conversation_id/phone
      const map = new Map<string, { conversationId: string | null; phone: string; jurisdiction: string; lastMessageAt: string; messagesCount: number }>();
      for (const row of data || []) {
        const key = `${row.jurisdiction}|${row.phone}|${row.conversation_id || ''}`;
        const existing = map.get(key);
        if (!existing) {
          map.set(key, {
            conversationId: row.conversation_id || null,
            phone: row.phone,
            jurisdiction: row.jurisdiction,
            lastMessageAt: row.created_at,
            messagesCount: 1,
          });
        } else {
          existing.messagesCount += 1;
        }
      }
      return Array.from(map.values());
    } catch (error) {
      this.logger.error('Erro ao listar conversas (Supabase BR):', error);
      return [];
    }
  }
}



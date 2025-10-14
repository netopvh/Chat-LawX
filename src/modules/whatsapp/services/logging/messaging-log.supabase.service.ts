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

  private async getActiveConversationId(phone: string): Promise<string | null> {
    try {
      const normalized = this.normalizePhone(phone);
      const { data, error } = await this.supabase.getClient()
        .from('whatsapp_conversations_br')
        .select('id')
        .eq('jurisdiction', 'BR')
        .eq('phone', normalized)
        .eq('status', 'active')
        .single();
      if (error) {
        if (error.code === 'PGRST116') return null;
        throw error;
      }
      return data?.id || null;
    } catch (e) {
      this.logger.error('Erro ao buscar conversa ativa (BR):', e);
      return null;
    }
  }

  private async ensureActiveConversation(phone: string): Promise<string> {
    const existing = await this.getActiveConversationId(phone);
    if (existing) return existing;
    const normalized = this.normalizePhone(phone);
    const { data, error } = await this.supabase.getClient()
      .from('whatsapp_conversations_br')
      .insert({ phone: normalized, jurisdiction: 'BR', status: 'active' })
      .select('id')
      .single();
    if (error) throw error;
    return data.id as string;
  }

  async startNewConversation(phone: string): Promise<string> {
    const normalized = this.normalizePhone(phone);
    // Fechar ativa
    await this.supabase.getClient()
      .from('whatsapp_conversations_br')
      .update({ status: 'closed', ended_at: new Date().toISOString() })
      .eq('jurisdiction', 'BR')
      .eq('phone', normalized)
      .eq('status', 'active');
    // Criar nova ativa
    const { data, error } = await this.supabase.getClient()
      .from('whatsapp_conversations_br')
      .insert({ phone: normalized, jurisdiction: 'BR', status: 'active' })
      .select('id')
      .single();
    if (error) throw error;
    return data.id as string;
  }

  private async touchConversation(conversationId: string): Promise<void> {
    try {
      await this.supabase.getClient()
        .from('whatsapp_conversations_br')
        .update({ last_message_at: new Date().toISOString(), messages_count: (this as any).supabase.rpc })
        .eq('id', conversationId);
      // Nota: se quiser atomicidade de incremento, usar RPC custom (função SQL) ou update com expressão.
      // Para simplicidade, faremos um update com incremento via expressão a seguir.
      await this.supabase.getClient().rpc('increment_messages_count', { conv_id: conversationId });
    } catch (e) {
      // Se RPC não existir, fazer fallback em duas queries simples (menos atômico, mas suficiente)
      try {
        await this.supabase.getClient()
          .from('whatsapp_conversations_br')
          .update({ last_message_at: new Date().toISOString() })
          .eq('id', conversationId);
        const { data } = await this.supabase.getClient()
          .from('whatsapp_conversations_br')
          .select('messages_count')
          .eq('id', conversationId)
          .single();
        const next = (data?.messages_count || 0) + 1;
        await this.supabase.getClient()
          .from('whatsapp_conversations_br')
          .update({ messages_count: next })
          .eq('id', conversationId);
      } catch (e2) {
        this.logger.error('Erro ao atualizar contadores da conversa (BR):', e2);
      }
    }
  }

  async logInboundText(params: BaseLogParams & { text: string }): Promise<void> {
    try {
      const client = this.supabase.getClient();
      const convId = await this.ensureActiveConversation(params.phone);
      await client.from('whatsapp_messages_br').insert({
        phone: this.normalizePhone(params.phone),
        jurisdiction: params.jurisdiction || 'BR',
        conversation_id: convId,
        session_external_id: params.sessionExternalId || null,
        direction: 'inbound',
        role: 'user',
        message_type: 'text',
        content: params.text,
      });
      await this.touchConversation(convId);
    } catch (error) {
      this.logger.error('Erro ao logar inbound text (Supabase BR):', error);
    }
  }

  async logOutboundText(params: BaseLogParams & { text: string; role?: 'assistant' | 'system'; model?: string; tokens?: number; json?: any }): Promise<void> {
    try {
      const client = this.supabase.getClient();
      const convId = await this.ensureActiveConversation(params.phone);
      await client.from('whatsapp_messages_br').insert({
        phone: this.normalizePhone(params.phone),
        jurisdiction: params.jurisdiction || 'BR',
        conversation_id: convId,
        session_external_id: params.sessionExternalId || null,
        direction: 'outbound',
        role: params.role || 'assistant',
        message_type: 'text',
        content: params.text,
        content_json: params.json || null,
        model: params.model || null,
        token_count: params.tokens || null,
      });
      await this.touchConversation(convId);
    } catch (error) {
      this.logger.error('Erro ao logar outbound text (Supabase BR):', error);
    }
  }

  async logInboundMedia(params: BaseLogParams & { messageType: 'audio' | 'image' | 'document'; url: string; json?: any }): Promise<void> {
    try {
      const client = this.supabase.getClient();
      const convId = await this.ensureActiveConversation(params.phone);
      await client.from('whatsapp_messages_br').insert({
        phone: this.normalizePhone(params.phone),
        jurisdiction: params.jurisdiction || 'BR',
        conversation_id: convId,
        session_external_id: params.sessionExternalId || null,
        direction: 'inbound',
        role: 'user',
        message_type: params.messageType,
        content_url: params.url,
        content_json: params.json || null,
      });
      await this.touchConversation(convId);
    } catch (error) {
      this.logger.error('Erro ao logar inbound media (Supabase BR):', error);
    }
  }

  async logOutboundMedia(params: BaseLogParams & { messageType: 'audio' | 'image' | 'document'; url: string; json?: any; model?: string; tokens?: number; role?: 'assistant' | 'system' }): Promise<void> {
    try {
      const client = this.supabase.getClient();
      const convId = await this.ensureActiveConversation(params.phone);
      await client.from('whatsapp_messages_br').insert({
        phone: this.normalizePhone(params.phone),
        jurisdiction: params.jurisdiction || 'BR',
        conversation_id: convId,
        session_external_id: params.sessionExternalId || null,
        direction: 'outbound',
        role: params.role || 'assistant',
        message_type: params.messageType,
        content_url: params.url,
        content_json: params.json || null,
        model: params.model || null,
        token_count: params.tokens || null,
      });
      await this.touchConversation(convId);
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
        .from('whatsapp_conversations_br')
        .select('id, phone, jurisdiction, status, last_message_at, messages_count')
        .order('last_message_at', { ascending: false });
      if (params.phone) query = query.eq('phone', this.normalizePhone(params.phone));
      if (params.since) query = query.gte('last_message_at', params.since);
      if (params.until) query = query.lte('last_message_at', params.until);
      if (params.limit) query = query.limit(Math.min(Math.max(params.limit, 1), 500));
      const { data } = await query;
      return (data || []).map(r => ({
        conversationId: r.id,
        phone: r.phone,
        jurisdiction: r.jurisdiction,
        lastMessageAt: r.last_message_at,
        messagesCount: r.messages_count,
        status: r.status,
      }));
    } catch (error) {
      this.logger.error('Erro ao listar conversas (Supabase BR):', error);
      return [];
    }
  }
}



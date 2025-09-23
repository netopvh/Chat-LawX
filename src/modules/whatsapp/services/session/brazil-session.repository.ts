import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../../supabase/supabase.service';

@Injectable()
export class BrazilSessionRepository {
  private readonly logger = new Logger(BrazilSessionRepository.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  private normalizePhone(phone: string): string {
    const clean = phone.replace(/\D/g, '');
    return clean.startsWith('55') ? clean.substring(2) : clean;
  }

  async findSessionByPhone(phone: string): Promise<any | null> {
    const number = this.normalizePhone(phone);
    const { data, error } = await this.supabaseService
      .getClient()
      .from('atendimento_wpps')
      .select('*')
      .eq('number', number)
      .single();
    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }
    return data;
  }

  async updateLastMessageSent(phone: string): Promise<void> {
    const number = this.normalizePhone(phone);
    const { error } = await this.supabaseService
      .getClient()
      .from('atendimento_wpps')
      .update({ last_message_sent: new Date().toISOString() })
      .eq('number', number);
    if (error) throw error;
  }

  async createSession(phone: string, name: string): Promise<any> {
    const number = this.normalizePhone(phone);
    const { data, error } = await this.supabaseService
      .getClient()
      .from('atendimento_wpps')
      .insert({ name, number })
      .select()
      .single();
    if (error) throw error;
    return data;
  }
}



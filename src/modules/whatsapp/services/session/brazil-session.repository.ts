import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../../supabase/supabase.service';

@Injectable()
export class BrazilSessionRepository {
  private readonly logger = new Logger(BrazilSessionRepository.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  private normalizeBrazilBase(phone: string): string {
    const clean = phone.replace(/\D/g, '');
    return clean.startsWith('55') ? clean.substring(2) : clean;
  }

  // Insere o dígito 9 após o DDD quando apropriado (base com 10 dígitos)
  private withNineInserted(base: string): string {
    if (base.length === 10) {
      return base.slice(0, 2) + '9' + base.slice(2);
    }
    if (base.length === 11 && base[2] === '9') {
      return base; // já possui 9
    }
    return base;
  }

  // Gera candidatos de número para BR: sem 9 e com 9 após DDD
  private generateCandidates(phone: string): string[] {
    const base = this.normalizeBrazilBase(phone);
    const candidates = new Set<string>();
    candidates.add(base);
    const withNine = this.withNineInserted(base);
    candidates.add(withNine);
    // Se já tem 11 com 9, também considerar sem 9 (para bases antigas)
    if (base.length === 11 && base[2] === '9') {
      const withoutNine = base.slice(0, 2) + base.slice(3);
      candidates.add(withoutNine);
    }
    return Array.from(candidates);
  }

  async findSessionByPhone(phone: string): Promise<any | null> {
    const candidates = this.generateCandidates(phone);
    for (const number of candidates) {
      const { data, error } = await this.supabaseService
        .getClient()
        .from('atendimento_wpps')
        .select('*')
        .eq('number', number)
        .single();
      if (data) return data;
      if (error && error.code !== 'PGRST116') {
        throw error;
      }
    }
    return null;
  }

  async updateLastMessageSent(phone: string): Promise<void> {
    // Encontrar sessão para identificar a chave 'number' usada no banco
    const existing = await this.findSessionByPhone(phone);
    if (!existing || !existing.number) return; // nada a atualizar
    const number = String(existing.number);
    const { error } = await this.supabaseService
      .getClient()
      .from('atendimento_wpps')
      .update({ last_message_sent: new Date().toISOString() })
      .eq('number', number);
    if (error) throw error;
  }

  async createSession(phone: string, name: string): Promise<any> {
    const base = this.normalizeBrazilBase(phone);
    const number = this.withNineInserted(base); // armazenar com dígito 9 quando aplicável
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



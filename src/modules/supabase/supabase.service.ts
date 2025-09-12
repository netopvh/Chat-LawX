import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService {
  private readonly logger = new Logger(SupabaseService.name);
  private supabase: SupabaseClient;

  constructor(private configService: ConfigService) {
    this.supabase = createClient(
      this.configService.get('SUPABASE_URL'),
      this.configService.get('SUPABASE_SERVICE_ROLE_KEY'),
    );
  }

  async uploadImage(file: Buffer, fileName: string): Promise<string> {
    try {
      const { data, error } = await this.supabase.storage
        .from('receipts')
        .upload(`${Date.now()}-${fileName}`, file, {
          contentType: 'image/jpeg',
          upsert: false,
        });

      if (error) {
        this.logger.error('Erro ao fazer upload:', error);
        throw new Error('Falha no upload da imagem');
      }

      const { data: { publicUrl } } = this.supabase.storage
        .from('receipts')
        .getPublicUrl(data.path);

      return publicUrl;
    } catch (error) {
      this.logger.error('Erro no upload:', error);
      throw new Error('Falha no upload da imagem');
    }
  }

  async uploadAudio(file: Buffer, fileName: string): Promise<string> {
    try {
      // Determinar o content-type baseado na extensão do arquivo
      const contentType = fileName.toLowerCase().endsWith('.mp3') 
        ? 'audio/mp3' 
        : 'audio/ogg';
      
      const { data, error } = await this.supabase.storage
        .from('audio')
        .upload(`${Date.now()}-${fileName}`, file, {
          contentType: contentType,
          upsert: false,
        });

      if (error) {
        this.logger.error('Erro ao fazer upload de áudio:', error);
        throw new Error('Falha no upload do áudio');
      }

      const { data: { publicUrl } } = this.supabase.storage
        .from('audio')
        .getPublicUrl(data.path);

      return publicUrl;
    } catch (error) {
      this.logger.error('Erro no upload de áudio:', error);
      throw new Error('Falha no upload do áudio');
    }
  }

  async deleteImage(filePath: string): Promise<void> {
    try {
      const { error } = await this.supabase.storage
        .from('receipts')
        .remove([filePath]);

      if (error) {
        this.logger.error('Erro ao deletar imagem:', error);
      }
    } catch (error) {
      this.logger.error('Erro ao deletar imagem:', error);
    }
  }

  getClient(): SupabaseClient {
    return this.supabase;
  }
} 
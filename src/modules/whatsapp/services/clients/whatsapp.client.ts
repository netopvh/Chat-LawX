import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpClientService } from './http.client';
import { IWhatsAppClient } from '../../interfaces/whatsapp-client.interface';

@Injectable()
export class WhatsAppClient implements IWhatsAppClient {
  private readonly logger = new Logger(WhatsAppClient.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly http: HttpClientService,
  ) {}

  async sendText(to: string, text: string, typingDelayMs?: number): Promise<void> {
    try {
      const evolutionApiUrl = this.configService.get<string>('EVOLUTION_API_URL');
      const instanceName = this.configService.get<string>('EVOLUTION_INSTANCE_NAME');
      const apiKey = this.configService.get<string>('EVOLUTION_API_KEY');

      if (typingDelayMs !== 0) {
        const delay = typingDelayMs || 1500;
        await this.sendTyping(to, delay);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      const url = `${evolutionApiUrl}/message/sendText/${instanceName}`;
      await this.http.post(
        url,
        { number: to, text },
        { headers: { 'Content-Type': 'application/json', apikey: apiKey } }
      );
      this.logger.log(`Mensagem enviada para ${to}${typingDelayMs !== undefined ? ` (delay: ${typingDelayMs || 1500}ms)` : ''}`);
    } catch (error) {
      this.logger.error('Erro ao enviar mensagem de texto:', error);
    }
  }

  async sendTyping(to: string, delayMs: number = 1200): Promise<void> {
    try {
      const evolutionApiUrl = this.configService.get<string>('EVOLUTION_API_URL');
      const instanceName = this.configService.get<string>('EVOLUTION_INSTANCE_NAME');
      const apiKey = this.configService.get<string>('EVOLUTION_API_KEY');

      const url = `${evolutionApiUrl}/chat/sendPresence/${instanceName}`;
      await this.http.post(
        url,
        { number: to, delay: delayMs, presence: 'composing' },
        { headers: { 'Content-Type': 'application/json', apikey: apiKey } }
      );
      this.logger.log(`Status "Digitando..." enviado para ${to}`);
    } catch (error) {
      this.logger.error('Erro ao enviar typing presence:', error);
    }
  }

  async sendImage(to: string, base64: string, caption?: string): Promise<void> {
    try {
      const evolutionApiUrl = this.configService.get<string>('EVOLUTION_API_URL');
      const instanceName = this.configService.get<string>('EVOLUTION_INSTANCE_NAME');
      const apiKey = this.configService.get<string>('EVOLUTION_API_KEY');

      const url = `${evolutionApiUrl}/message/sendMedia/${instanceName}`;
      await this.http.post(
        url,
        {
          number: to,
          mediatype: 'image',
          mimetype: 'image/png',
          media: base64,
          caption: caption || '',
        },
        { headers: { 'Content-Type': 'application/json', apikey: apiKey } }
      );
      this.logger.log(`Imagem enviada para ${to}`);
    } catch (error) {
      this.logger.error('Erro ao enviar imagem:', error);
    }
  }
}



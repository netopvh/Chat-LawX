import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpClientService } from './http.client';
import { IWhatsAppClient } from '../../interfaces/whatsapp-client.interface';

@Injectable()
export class CloudWhatsAppClient implements IWhatsAppClient {
  private readonly logger = new Logger(CloudWhatsAppClient.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly http: HttpClientService,
  ) {}

  // Cloud API não possui typing presence. No-op.
  async sendTyping(_to: string, _delayMs?: number): Promise<void> {
    return;
  }

  async sendText(to: string, text: string): Promise<void> {
    try {
      const token = this.configService.get<string>('WHATSAPP_CLOUD_ACCESS_TOKEN');
      const phoneNumberId = this.configService.get<string>('WHATSAPP_CLOUD_PHONE_NUMBER_ID');
      const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;

      await this.http.post(
        url,
        {
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: text },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          timeout: 30000,
        },
      );

      this.logger.log(`Mensagem (Cloud) enviada para ${to}`);
    } catch (error) {
      this.logger.error('Erro ao enviar mensagem (Cloud):', error);
    }
  }

  // Envio de imagem por Cloud API requer upload prévio (media) ou link público.
  // Para manter escopo, se necessário, utilizar link público.
  async sendImage(to: string, base64OrLink: string, caption?: string): Promise<void> {
    try {
      const token = this.configService.get<string>('WHATSAPP_CLOUD_ACCESS_TOKEN');
      const phoneNumberId = this.configService.get<string>('WHATSAPP_CLOUD_PHONE_NUMBER_ID');
      const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;

      // Se receber um link http(s), usa diretamente; caso contrário, ignora e loga.
      const isLink = /^https?:\/\//i.test(base64OrLink);
      if (!isLink) {
        this.logger.warn('Cloud sendImage requer link público ou upload prévio. Ignorando base64.');
        return;
      }

      await this.http.post(
        url,
        {
          messaging_product: 'whatsapp',
          to,
          type: 'image',
          image: { link: base64OrLink, caption: caption || '' },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          timeout: 30000,
        },
      );
      this.logger.log(`Imagem (Cloud) enviada para ${to}`);
    } catch (error) {
      this.logger.error('Erro ao enviar imagem (Cloud):', error);
    }
  }
}



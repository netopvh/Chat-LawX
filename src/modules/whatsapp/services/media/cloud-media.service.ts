import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpClientService } from '../clients/http.client';

@Injectable()
export class CloudMediaService {
  private readonly logger = new Logger(CloudMediaService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly http: HttpClientService,
  ) {}

  async getMediaUrl(mediaId: string): Promise<{ url: string; mimeType?: string }> {
    const token = this.configService.get<string>('WHATSAPP_CLOUD_ACCESS_TOKEN');
    const url = `https://graph.facebook.com/v20.0/${mediaId}`;
    const resp = await this.http.get<any>(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 30000,
      responseType: 'json',
    });
    return { url: resp.data.url, mimeType: resp.data.mime_type };
  }

  async downloadMediaById(mediaId: string): Promise<Buffer> {
    const { url } = await this.getMediaUrl(mediaId);
    const token = this.configService.get<string>('WHATSAPP_CLOUD_ACCESS_TOKEN');
    // Para Cloud API, é necessário enviar novamente o Bearer token no download da mídia (lookaside)
    const resp = await this.http.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: 60000,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/octet-stream',
      },
    });
    const buffer = Buffer.from(resp.data as any);
    if (!buffer || buffer.length === 0) {
      throw new Error('Mídia vazia ou não encontrada');
    }
    return buffer;
  }
}



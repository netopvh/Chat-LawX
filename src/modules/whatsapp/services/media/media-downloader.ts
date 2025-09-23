import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpClientService } from '../clients/http.client';

@Injectable()
export class MediaDownloader {
  private readonly logger = new Logger(MediaDownloader.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly http: HttpClientService,
  ) {}

  // ========== IMAGES ==========
  async downloadImageFromMessage(messageData: any): Promise<Buffer> {
    const imageUrl = messageData.message?.imageMessage?.url;
    try {
      try {
        return await this.downloadFromWhatsAppMedia(messageData);
      } catch (mediaError) {
        this.logger.warn(`Falha na API de mídia (base64), tentando fallback: ${mediaError.message}`);
      }

      try {
        return await this.downloadFromMessagesAPI(messageData);
      } catch (fallbackError) {
        this.logger.warn(`Falha no fallback (base64), tentando download direto: ${fallbackError.message}`);
      }

      if (!imageUrl) {
        throw new Error('URL da imagem não encontrada para download direto');
      }
      return await this.downloadDirectFromUrl(imageUrl);
    } catch (error) {
      this.logger.error('Erro ao baixar imagem:', error);
      throw new Error(`Falha ao baixar imagem: ${error.message}`);
    }
  }

  private async downloadFromWhatsAppMedia(messageData: any): Promise<Buffer> {
    const messageId = messageData.key?.id;
    if (!messageId) {
      throw new Error('ID da mensagem não encontrado');
    }

    const evolutionApiUrl = this.configService.get<string>('EVOLUTION_API_URL');
    const instanceName = this.configService.get<string>('EVOLUTION_INSTANCE_NAME');
    const apiKey = this.configService.get<string>('EVOLUTION_API_KEY');

    const mediaUrl = `${evolutionApiUrl}/chat/getBase64FromMediaMessage/${instanceName}`;
    const payload = { message: { key: { id: messageId } }, convertToMp4: false };

    const data = await this.http.post<any>(mediaUrl, payload, {
      headers: { 'Content-Type': 'application/json', apikey: apiKey },
      timeout: 30000,
    });

    if (data && data.base64) {
      return Buffer.from(data.base64, 'base64');
    }
    throw new Error('Base64 não encontrado na resposta');
  }

  private async downloadFromMessagesAPI(messageData: any): Promise<Buffer> {
    const messageId = messageData.key?.id;
    if (!messageId) {
      throw new Error('ID da mensagem não encontrado (fallback)');
    }

    const evolutionApiUrl = this.configService.get<string>('EVOLUTION_API_URL');
    const instanceName = this.configService.get<string>('EVOLUTION_INSTANCE_NAME');
    const apiKey = this.configService.get<string>('EVOLUTION_API_KEY');

    const mediaUrl = `${evolutionApiUrl}/chat/getBase64FromMediaMessage/${instanceName}`;
    const payload = { message: { key: { id: messageId } }, convertToMp4: false };

    const data = await this.http.post<any>(mediaUrl, payload, {
      headers: { 'Content-Type': 'application/json', apikey: apiKey },
      timeout: 30000,
    });

    if (data && data.base64) {
      return Buffer.from(data.base64, 'base64');
    }
    throw new Error('Base64 não encontrado na resposta (fallback)');
  }

  private async downloadDirectFromUrl(url: string): Promise<Buffer> {
    const headers = {
      'User-Agent': 'WhatsApp/2.23.24.78 A',
      'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Sec-Fetch-Dest': 'image',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'cross-site',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Referer': 'https://web.whatsapp.com/',
    };

    const response = await this.http.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      headers,
      timeout: 30000,
      maxRedirects: 10,
      validateStatus: (status) => (status as number) < 400,
    });

    const buffer = Buffer.from(response.data as any);
    if (buffer.length === 0) {
      throw new Error('Buffer vazio recebido');
    }
    return buffer;
  }

  // ========== AUDIO ==========
  async downloadAudioFromMessage(messageData: any): Promise<Buffer | null> {
    try {
      // Prefer Evolution API download
      const viaApi = await this.downloadAudioFromEvolutionAPI(messageData);
      if (viaApi) return viaApi;

      // Fallback direct URL
      const audioMessage = messageData.message?.audioMessage;
      if (audioMessage?.url) {
        return await this.downloadDirectFromUrl(audioMessage.url);
      }
      return null;
    } catch (error) {
      this.logger.error('Erro ao baixar áudio:', error);
      return null;
    }
  }

  private async downloadAudioFromEvolutionAPI(messageData: any): Promise<Buffer | null> {
    try {
      const evolutionApiUrl = this.configService.get<string>('EVOLUTION_API_URL');
      const evolutionApiKey = this.configService.get<string>('EVOLUTION_API_KEY');
      const instanceName = this.configService.get<string>('EVOLUTION_INSTANCE_NAME');

      const messageId = messageData.message?.key?.id || messageData.key?.id;
      if (!messageId) return null;

      // Try base64 endpoint first
      try {
        const response = await fetch(`${evolutionApiUrl}/chat/getBase64FromMediaMessage/${instanceName}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': evolutionApiKey },
          body: JSON.stringify({ message: { key: { id: messageId } }, convertToMp4: true }),
        });
        if (response.ok) {
          const result = await response.json();
          if (result.base64) {
            return Buffer.from(result.base64, 'base64');
          }
        }
      } catch (err) {
        this.logger.warn('getBase64FromMediaMessage indisponível, tentando downloadMedia');
      }

      // Fallback: downloadMedia se houver metadados
      const audioMessage = messageData.message?.audioMessage;
      if (!audioMessage) return null;

      const dlResp = await fetch(`${evolutionApiUrl}/chat/downloadMedia/${instanceName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': evolutionApiKey },
        body: JSON.stringify({
          url: audioMessage.url,
          mimetype: audioMessage.mimetype,
          mediaKey: audioMessage.mediaKey,
          fileEncSha256: audioMessage.fileEncSha256,
          fileSha256: audioMessage.fileSha256,
          fileLength: audioMessage.fileLength,
          seconds: audioMessage.seconds,
          ptt: audioMessage.ptt,
          directPath: audioMessage.directPath,
          mediaKeyTimestamp: audioMessage.mediaKeyTimestamp,
          streamingSidecar: audioMessage.streamingSidecar,
          waveform: audioMessage.waveform,
        }),
      });
      if (dlResp.ok) {
        const arr = await dlResp.arrayBuffer();
        const buf = Buffer.from(arr);
        if (buf.length > 0) return buf;
      }
      return null;
    } catch (error) {
      this.logger.error('Erro no download via Evolution API:', error);
      return null;
    }
  }
}



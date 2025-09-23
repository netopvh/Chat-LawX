import { Injectable, Logger } from '@nestjs/common';
import { UploadService } from '../../../upload/upload.service';
import { AiService } from '../../../ai/ai.service';

@Injectable()
export class AudioProcessor {
  private readonly logger = new Logger(AudioProcessor.name);

  constructor(
    private readonly uploadService: UploadService,
    private readonly aiService: AiService,
  ) {}

  async convertToMp3WithFallback(audioBuffer: Buffer): Promise<Buffer> {
    try {
      const mp3Buffer = await this.uploadService.convertAudioToMp3(audioBuffer);
      return mp3Buffer;
    } catch (conversionError) {
      this.logger.warn('Falha na conversão para MP3, tentando conversão simples:', conversionError.message);
      try {
        const simpleBuffer = await this.uploadService.convertAudioSimple(audioBuffer);
        return simpleBuffer;
      } catch (simpleError) {
        this.logger.warn('Falha na conversão simples, usando buffer original:', simpleError.message);
        return audioBuffer;
      }
    }
  }

  async uploadAudio(buffer: Buffer, fileName: string = 'audio.mp3'): Promise<string> {
    return this.uploadService.uploadAudioFile(buffer, fileName);
  }

  async transcribe(buffer: Buffer): Promise<string> {
    return this.aiService.processAudioForLegalConsultation(buffer);
  }
}



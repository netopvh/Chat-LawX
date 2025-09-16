import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import * as ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  constructor(private supabaseService: SupabaseService) {}

  async uploadReceiptImage(file: Buffer, originalName: string): Promise<string> {
    try {
      const fileName = this.sanitizeFileName(originalName);
      const publicUrl = await this.supabaseService.uploadImage(file, fileName);
      
      this.logger.log(`Imagem enviada com sucesso: ${publicUrl}`);
      return publicUrl;
    } catch (error) {
      this.logger.error('Erro no upload:', error);
      throw error;
    }
  }

  async uploadAudioFile(file: Buffer, originalName: string): Promise<string> {
    try {
      const fileName = this.sanitizeFileName(originalName);
      const publicUrl = await this.supabaseService.uploadAudio(file, fileName);
      
      this.logger.log(`Áudio enviado com sucesso: ${publicUrl}`);
      return publicUrl;
    } catch (error) {
      this.logger.error('Erro no upload de áudio:', error);
      throw error;
    }
  }

  async uploadDocumentFile(file: Buffer, fileName: string): Promise<string> {
    try {
      const sanitizedFileName = this.sanitizeFileName(fileName);
      const publicUrl = await this.supabaseService.uploadDocument(file, sanitizedFileName);
      
      this.logger.log(`Documento enviado com sucesso: ${publicUrl}`);
      return publicUrl;
    } catch (error) {
      this.logger.error('Erro no upload de documento:', error);
      throw error;
    }
  }

  /**
   * Converte áudio base64 para MP3 usando ffmpeg
   */
  async convertAudioToMp3(audioBuffer: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        this.logger.log('🔄 Convertendo áudio para MP3...');
        
        // Criar arquivos temporários
        const tempDir = os.tmpdir();
        const inputPath = path.join(tempDir, `input_${Date.now()}.ogg`);
        const outputPath = path.join(tempDir, `output_${Date.now()}.mp3`);
        
        // Escrever buffer de entrada
        fs.writeFileSync(inputPath, audioBuffer);
        
        // Converter usando ffmpeg
        ffmpeg(inputPath)
          .toFormat('mp3')
          .audioCodec('libmp3lame')
          .audioBitrate(128)
          .audioChannels(1)
          .audioFrequency(22050)
          .on('end', () => {
            try {
              // Ler arquivo de saída
              const outputBuffer = fs.readFileSync(outputPath);
              
              // Limpar arquivos temporários
              fs.unlinkSync(inputPath);
              fs.unlinkSync(outputPath);
              
              this.logger.log('✅ Conversão para MP3 concluída:', outputBuffer.length, 'bytes');
              resolve(outputBuffer);
            } catch (error) {
              this.logger.error('❌ Erro ao ler arquivo convertido:', error);
              reject(error);
            }
          })
          .on('error', (error) => {
            this.logger.error('❌ Erro na conversão ffmpeg:', error);
            
            // Limpar arquivos temporários em caso de erro
            try {
              if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
              if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            } catch (cleanupError) {
              this.logger.warn('⚠️ Erro ao limpar arquivos temporários:', cleanupError);
            }
            
            reject(error);
          })
          .save(outputPath);
          
      } catch (error) {
        this.logger.error('❌ Erro ao preparar conversão:', error);
        reject(error);
      }
    });
  }

  /**
   * Fallback: converte áudio para formato mais compatível sem ffmpeg
   */
  async convertAudioSimple(audioBuffer: Buffer): Promise<Buffer> {
    try {
      this.logger.log('🔄 Conversão simples de áudio...');
      
      // Verificar se já é MP3 pelos primeiros bytes
      const header = audioBuffer.slice(0, 4);
      const headerHex = header.toString('hex').toLowerCase();
      
      if (headerHex.startsWith('fffb') || headerHex.startsWith('fff3') || headerHex.startsWith('fff2')) {
        this.logger.log('✅ Áudio já é MP3');
        return audioBuffer;
      }
      
      // Se não for MP3, tentar enviar como está (pode funcionar com OpenAI)
      this.logger.log('⚠️ Áudio não é MP3, enviando como está');
      return audioBuffer;
      
    } catch (error) {
      this.logger.error('❌ Erro na conversão simples:', error);
      throw error;
    }
  }

  private sanitizeFileName(fileName: string): string {
    return fileName
      .replace(/[^a-zA-Z0-9.-]/g, '_')
      .toLowerCase();
  }
} 
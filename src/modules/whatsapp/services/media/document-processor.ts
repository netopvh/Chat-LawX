import { Injectable, Logger } from '@nestjs/common';
import { HttpClientService } from '../clients/http.client';
import { UploadService } from '../../../upload/upload.service';

@Injectable()
export class DocumentProcessor {
  private readonly logger = new Logger(DocumentProcessor.name);

  constructor(
    private readonly uploadService: UploadService,
    private readonly http: HttpClientService,
  ) {}

  convertBase64ToBuffer(base64Data: string): Buffer {
    const base64 = base64Data.replace(/^data:[^;]+;base64,/, '');
    return Buffer.from(base64, 'base64');
  }

  detectDocumentMime(buffer: Buffer): string {
    const header = buffer.slice(0, 8);
    const headerHex = header.toString('hex').toLowerCase();
    if (headerHex.startsWith('25504446')) return 'application/pdf';
    if (headerHex.startsWith('504b0304') || headerHex.startsWith('504b0506')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (headerHex.startsWith('d0cf11e0')) return 'application/msword';
    return 'unknown';
  }

  isSupportedDocumentType(mimeType: string): boolean {
    return [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ].includes(mimeType);
  }

  generateFileName(mimeType: string): string {
    const timestamp = Date.now();
    const extensions: { [key: string]: string } = {
      'application/pdf': 'pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/msword': 'doc'
    };
    const ext = extensions[mimeType] || 'bin';
    return `document-${timestamp}.${ext}`;
  }

  async upload(buffer: Buffer, fileName: string): Promise<string> {
    return this.uploadService.uploadDocumentFile(buffer, fileName);
  }

  async analyzeDocumentWithExternalAPI(fileUrl: string, jurisdiction?: string): Promise<any> {
    try {
      const promptText = this.generateLocalizedAnalysisPrompt(jurisdiction);
      const data = await this.http.post<any>(
        'https://us-central1-gleaming-nomad-443014-u2.cloudfunctions.net/vertex-LawX-personalizada',
        { prompt_text: promptText, file_url: fileUrl },
        { headers: { 'Content-Type': 'application/json' } }
      );
      return typeof data === 'string' ? JSON.parse(data) : data;
    } catch (error) {
      this.logger.error('Erro na análise externa:', error);
      throw new Error('Falha na análise do documento. Tente novamente.');
    }
  }

  formatDocumentAnalysisForUser(analysisData: any, jurisdiction?: string): string {
    try {
      const isSpanish = jurisdiction === 'ES';
      const isPortuguese = jurisdiction === 'PT';
      let formattedText: string;
      let labels: any;
      if (isSpanish) {
        formattedText = '📄 **ANÁLISIS JURÍDICO DEL DOCUMENTO**\n\n';
        labels = {
          documentType: '📋 **Tipo de Documento:**',
          parties: '👥 **Partes Involucradas:**',
          mainObjective: '🎯 **Objetivo Principal:**',
          importantPoints: '⭐ **Puntos Importantes:**',
          relevantClauses: '📜 **Cláusulas/Artículos Relevantes:**',
          deadlinesAndValues: '⏰ **Plazos y Valores:**',
          identifiedRisks: '⚠️ **Riesgos Identificados:**',
          recommendations: '💡 **Recomendaciones:**',
          executiveSummary: '📝 **Resumen Ejecutivo:**',
          completed: '✅ *¡Análisis completado con éxito!*'
        };
      } else if (isPortuguese) {
        formattedText = '📄 **ANÁLISE JURÍDICA DO DOCUMENTO**\n\n';
        labels = {
          documentType: '📋 **Tipo de Documento:**',
          parties: '👥 **Partes Envolvidas:**',
          mainObjective: '🎯 **Objetivo Principal:**',
          importantPoints: '⭐ **Pontos Importantes:**',
          relevantClauses: '📜 **Cláusulas/Artigos Relevantes:**',
          deadlinesAndValues: '⏰ **Prazos e Valores:**',
          identifiedRisks: '⚠️ **Riscos Identificados:**',
          recommendations: '💡 **Recomendações:**',
          executiveSummary: '📝 **Resumo Executivo:**',
          completed: '✅ *Análise concluída com sucesso!*'
        };
      } else {
        formattedText = '📄 **ANÁLISE JURÍDICA DO DOCUMENTO**\n\n';
        labels = {
          documentType: '📋 **Tipo de Documento:**',
          parties: '👥 **Partes Envolvidas:**',
          mainObjective: '🎯 **Objetivo Principal:**',
          importantPoints: '⭐ **Pontos Importantes:**',
          relevantClauses: '📜 **Cláusulas/Artigos Relevantes:**',
          deadlinesAndValues: '⏰ **Prazos e Valores:**',
          identifiedRisks: '⚠️ **Riscos Identificados:**',
          recommendations: '💡 **Recomendações:**',
          executiveSummary: '📝 **Resumo Executivo:**',
          completed: '✅ *Análise concluída com sucesso!*'
        };
      }

      if (analysisData.documentType) {
        formattedText += `${labels.documentType} ${analysisData.documentType}\n\n`;
      }
      if (analysisData.parties && Array.isArray(analysisData.parties) && analysisData.parties.length > 0) {
        formattedText += `${labels.parties}\n`;
        analysisData.parties.forEach((party: string) => {
          formattedText += `• ${party}\n`;
        });
        formattedText += '\n';
      }
      if (analysisData.mainObjective) {
        formattedText += `${labels.mainObjective}\n${analysisData.mainObjective}\n\n`;
      }
      if (analysisData.importantPoints && Array.isArray(analysisData.importantPoints) && analysisData.importantPoints.length > 0) {
        formattedText += `${labels.importantPoints}\n`;
        analysisData.importantPoints.forEach((point: string) => {
          formattedText += `• ${point}\n`;
        });
        formattedText += '\n';
      }
      if (analysisData.relevantClauses && Array.isArray(analysisData.relevantClauses) && analysisData.relevantClauses.length > 0) {
        formattedText += `${labels.relevantClauses}\n`;
        analysisData.relevantClauses.forEach((clause: string) => {
          formattedText += `• ${clause}\n`;
        });
        formattedText += '\n';
      }
      if (analysisData.deadlinesAndValues) {
        formattedText += `${labels.deadlinesAndValues}\n${analysisData.deadlinesAndValues}\n\n`;
      }
      if (analysisData.identifiedRisks && Array.isArray(analysisData.identifiedRisks) && analysisData.identifiedRisks.length > 0) {
        formattedText += `${labels.identifiedRisks}\n`;
        analysisData.identifiedRisks.forEach((risk: string) => {
          formattedText += `• ${risk}\n`;
        });
        formattedText += '\n';
      }
      if (analysisData.recommendations && Array.isArray(analysisData.recommendations) && analysisData.recommendations.length > 0) {
        formattedText += `${labels.recommendations}\n`;
        analysisData.recommendations.forEach((recommendation: string) => {
          formattedText += `• ${recommendation}\n`;
        });
        formattedText += '\n';
      }
      if (analysisData.executiveSummary) {
        formattedText += `${labels.executiveSummary}\n${analysisData.executiveSummary}\n\n`;
      }
      formattedText += '---\n';
      formattedText += labels.completed;
      return formattedText;
    } catch (error) {
      this.logger.error('Erro ao formatar análise:', error);
      return '❌ Erro ao processar a análise do documento.';
    }
  }

  private generateLocalizedAnalysisPrompt(jurisdiction?: string): string {
    const isSpanish = jurisdiction === 'ES';
    const isPortuguese = jurisdiction === 'PT';
    if (isSpanish) {
      return `Analiza este documento jurídico y proporciona un resumen completo y detallado.

IMPORTANTE: Devuelve la respuesta EXACTAMENTE en el formato JSON siguiente, sin texto adicional:

{\n  "documentType": "tipo de documento (contrato, petición, dictamen, sentencia, etc.)",\n  "parties": ["lista de las partes involucradas"],\n  "mainObjective": "objetivo principal del documento",\n  "importantPoints": ["lista de los puntos más relevantes"],\n  "relevantClauses": ["cláusulas o artículos más importantes"],\n  "deadlinesAndValues": "plazos, valores y fechas importantes",\n  "identifiedRisks": ["riesgos o problemas identificados"],\n  "recommendations": ["sugerencias prácticas"],\n  "executiveSummary": "resumen conciso de los puntos principales"\n}

Sé específico, práctico y proporciona un análisis jurídico completo y útil.`;
    }
    if (isPortuguese) {
      return `Analisa este documento jurídico e fornece um resumo completo e detalhado.

IMPORTANTE: Retorna a resposta EXATAMENTE no formato JSON abaixo, sem texto adicional:

{\n  "documentType": "tipo do documento (contrato, petição, parecer, sentença, etc.)",\n  "parties": ["lista das partes envolvidas"],\n  "mainObjective": "objetivo principal do documento",\n  "importantPoints": ["lista dos pontos mais relevantes"],\n  "relevantClauses": ["cláusulas ou artigos mais importantes"],\n  "deadlinesAndValues": "prazos, valores e datas importantes",\n  "identifiedRisks": ["riscos ou problemas identificados"],\n  "recommendations": ["sugestões práticas"],\n  "executiveSummary": "resumo conciso dos pontos principais"\n}

Seja específico, prático e forneça uma análise jurídica completa e útil.`;
    }
    return `Analise este documento jurídico e forneça um resumo completo e detalhado. 

IMPORTANTE: Retorne a resposta EXATAMENTE no formato JSON abaixo, sem texto adicional:

{\n  "documentType": "tipo do documento (contrato, petição, parecer, sentença, etc.)",\n  "parties": ["lista das partes envolvidas"],\n  "mainObjective": "objetivo principal do documento",\n  "importantPoints": ["lista dos pontos mais relevantes"],\n  "relevantClauses": ["cláusulas ou artigos mais importantes"],\n  "deadlinesAndValues": "prazos, valores e datas importantes",\n  "identifiedRisks": ["riscos ou problemas identificados"],\n  "recommendations": ["sugestões práticas"],\n  "executiveSummary": "resumo conciso dos pontos principais"\n}

Seja específico, prático e forneça uma análise jurídica completa e útil.`;
  }
}



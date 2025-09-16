import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import * as Tesseract from 'tesseract.js';
import * as fs from 'fs';
import * as path from 'path';
import * as sharp from 'sharp';
import { LegalPromptsService } from '../legal-prompts/legal-prompts.service';
import { JurisdictionService } from '../jurisdiction/jurisdiction.service';
import { TeamsService } from '../teams/teams.service';
import { PrismaService } from '../prisma/prisma.service';


@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private gemini: GoogleGenerativeAI;
  private openai: OpenAI;

  constructor(
    private configService: ConfigService,
    private legalPromptsService: LegalPromptsService,
    private jurisdictionService: JurisdictionService,
    private teamsService: TeamsService,
    private prismaService: PrismaService,
  ) {
    this.gemini = new GoogleGenerativeAI(this.configService.get('GEMINI_API_KEY'));
    this.openai = new OpenAI({
      apiKey: this.configService.get('OPENAI_API_KEY'),
    });
  }




















  async generatePlanUpgradeResponse(userMessage: string, state: any): Promise<string> {
    const prompt = `
      Você é um assistente de vendas especializado em planos de assinatura.
      
      Contexto atual:
      - Usuário está no fluxo de upgrade
      - Plano selecionado: ${state.selectedPlan || 'Nenhum'}
      - Frequência selecionada: ${state.selectedFrequency || 'Nenhuma'}
      - Step atual: ${state.upgradeStep}
      
      Mensagem do usuário: "${userMessage}"
      
      Responda de forma amigável e natural, ajudando o usuário a:
      1. Escolher entre Pro (R$ 19,90/mês) e Premium (R$ 39,90/mês)
      2. Decidir entre mensal e anual
      3. Entender os benefícios
      4. Finalizar a compra
      
      Seja persuasivo mas não agressivo. Use emojis ocasionalmente.
      Responda em português brasileiro de forma natural.
      
      Se o usuário tiver dúvidas sobre planos, explique os benefícios:
      - Pro: 100 despesas, 100 relatórios, 500 mensagens
      - Premium: ilimitado em tudo
      
      Se tiver dúvidas sobre pagamento, explique que aceitamos PIX.
    `;
    
    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Você é um assistente de vendas especializado em planos de assinatura. Seja persuasivo mas não agressivo.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
      });

      const response = completion.choices[0]?.message?.content;
      return response || 'Desculpe, não consegui processar sua mensagem. Pode tentar novamente?';
    } catch (error) {
      this.logger.error('❌ Erro ao gerar resposta de upgrade:', error);
      return 'Desculpe, não consegui processar sua mensagem. Pode tentar novamente?';
    }
  }








  /**
   * Transcreve áudio usando OpenAI Whisper API
   * @param audioBuffer Buffer do arquivo de áudio
   * @returns Texto transcrito
   */
  async transcribeAudio(audioBuffer: Buffer): Promise<string> {
    try {
      this.logger.log('🎵 Iniciando transcrição de áudio...');
      
      // Verificar se o buffer é válido
      if (!audioBuffer || audioBuffer.length === 0) {
        throw new Error('Buffer de áudio vazio ou inválido');
      }

      this.logger.log('📊 Tamanho do áudio:', audioBuffer.length, 'bytes');

      // Detectar formato do áudio baseado nos primeiros bytes
      const contentType = this.detectAudioFormat(audioBuffer);
      this.logger.log('🎵 Formato detectado:', contentType);

      // Ordem de prioridade para tentativas (MP3 primeiro, depois outros)
      const formatsToTry = [
        'audio/mp3', // Priorizar MP3
        contentType, // Formato detectado
        'audio/wav',
        'audio/ogg',
        'audio/mp4',
        'audio/flac'
      ];

      // Remover duplicatas mantendo a ordem
      const uniqueFormats = [...new Set(formatsToTry)];

      let lastError: Error | null = null;

      for (const format of uniqueFormats) {
        try {
          this.logger.log(`🎵 Tentando formato: ${format}`);
          
          // Converter buffer para FormData para envio à API
          const formData = new FormData();
          const audioBlob = new Blob([audioBuffer], { type: format });
          formData.append('file', audioBlob, `audio.${this.getFileExtension(format)}`);
          formData.append('model', 'whisper-1');
          formData.append('language', 'pt'); // Português brasileiro
          formData.append('response_format', 'json');

          // Fazer requisição para OpenAI Whisper API
          const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.configService.get('OPENAI_API_KEY')}`,
            },
            body: formData,
          });

          if (!response.ok) {
            const errorText = await response.text();
            lastError = new Error(`Erro na transcrição: ${response.status} - ${errorText}`);
            this.logger.warn(`⚠️ Falha com formato ${format}:`, errorText);
            continue; // Tentar próximo formato
          }

          const result = await response.json();
          const transcribedText = result.text?.trim();

          if (!transcribedText) {
            lastError = new Error('Transcrição retornou texto vazio');
            continue; // Tentar próximo formato
          }

          this.logger.log('✅ Transcrição concluída:', transcribedText);
          return transcribedText;

        } catch (error) {
          lastError = error;
          this.logger.warn(`⚠️ Erro com formato ${format}:`, error.message);
          continue; // Tentar próximo formato
        }
      }

      // Se chegou aqui, todos os formatos falharam
      throw lastError || new Error('Falha na transcrição com todos os formatos testados');

    } catch (error) {
      this.logger.error('❌ Erro na transcrição de áudio:', error);
      throw error;
    }
  }

  /**
   * Detecta o formato do áudio baseado nos primeiros bytes
   */
  private detectAudioFormat(buffer: Buffer): string {
    const header = buffer.slice(0, 12);
    const headerHex = header.toString('hex').toLowerCase();

    // Detectar formatos comuns
    if (headerHex.startsWith('4f676753')) return 'audio/ogg'; // OGG
    if (headerHex.startsWith('494433')) return 'audio/mp3'; // MP3
    if (headerHex.startsWith('52494646')) return 'audio/wav'; // WAV
    if (headerHex.startsWith('66747970')) return 'audio/mp4'; // MP4/M4A
    if (headerHex.startsWith('464c4143')) return 'audio/flac'; // FLAC

    // Detecção adicional para MP3 (pode ter diferentes headers)
    if (headerHex.startsWith('fffb') || headerHex.startsWith('fff3') || headerHex.startsWith('fff2')) {
      return 'audio/mp3';
    }

    // Se não conseguir detectar, assumir OGG (padrão do WhatsApp)
    this.logger.log('⚠️ Formato não detectado, assumindo OGG');
    return 'audio/ogg';
  }

  /**
   * Obtém a extensão do arquivo baseado no content-type
   */
  private getFileExtension(contentType: string): string {
    const extensions: { [key: string]: string } = {
      'audio/ogg': 'ogg',
      'audio/mp3': 'mp3',
      'audio/wav': 'wav',
      'audio/mp4': 'm4a',
      'audio/flac': 'flac',
      'audio/webm': 'webm'
    };
    return extensions[contentType] || 'ogg';
  }

  /**
   * Processa áudio para consulta jurídica
   */
  async processAudioForLegalConsultation(audioBuffer: Buffer): Promise<string> {
    try {
      this.logger.log('🎵 Processando áudio para consulta jurídica...');

      // 1. Tentar transcrição direta
      let transcribedText: string;
      try {
        transcribedText = await this.transcribeAudio(audioBuffer);
      } catch (error) {
        this.logger.warn('⚠️ Falha na transcrição direta, tentando conversão...');
        
        // 2. Se falhar, tentar converter para formato mais compatível
        const convertedBuffer = await this.convertAudioToCompatibleFormat(audioBuffer);
        transcribedText = await this.transcribeAudio(convertedBuffer);
      }
      
      this.logger.log('🎵 Transcrição concluída:', transcribedText);
      return transcribedText;

    } catch (error) {
      this.logger.error('❌ Erro no processamento de áudio:', error);
      throw error;
    }
  }

  /**
   * Converte áudio para formato mais compatível com OpenAI Whisper
   */
  private async convertAudioToCompatibleFormat(audioBuffer: Buffer): Promise<Buffer> {
    try {
      // Verificar se já é um formato compatível
      const format = this.detectAudioFormat(audioBuffer);
      if (format === 'mp3' || format === 'wav') {
        return audioBuffer;
      }

      // Para outros formatos, retornar como está (será processado pelo OpenAI)
      this.logger.log('⚠️ Formato de áudio não otimizado:', format);
      return audioBuffer;
    } catch (error) {
      this.logger.error('❌ Erro ao converter áudio:', error);
      return audioBuffer;
    }
  }

  async analyzePlanUpgradeIntent(text: string, context: any): Promise<{
    confidence: number;
    intent: 'new_upgrade' | 'continue_upgrade' | 'payment_confirmation' | 'frequency_selection' | 'plan_selection' | 'cancel_upgrade';
    reasoning: string;
  }> {
    try {
      this.logger.log('🧠 Analisando intent de upgrade com IA:', text);
      this.logger.log('📋 Contexto:', context);

      const prompt = `Analise a seguinte mensagem do usuário no contexto de um fluxo de upgrade de plano e determine a intenção.

Contexto atual:
- Passo atual: ${context.currentStep || 'desconhecido'}
- Plano selecionado: ${context.selectedPlan || 'nenhum'}
- Frequência selecionada: ${context.selectedFrequency || 'nenhuma'}
- Valor: R$ ${context.amount || 0}

Mensagem do usuário: "${text}"

Responda apenas com um JSON no seguinte formato:
{
  "confidence": 0.0-1.0,
  "intent": "payment_confirmation|frequency_selection|plan_selection|cancel_upgrade|continue_upgrade",
  "reasoning": "explicação da análise"
}

Critérios para cada intent:
- payment_confirmation: Usuário confirma pagamento (sim, ok, pode ser, vamos, pagar, prosseguir)
- frequency_selection: Usuário escolhe frequência (mensal, anual, monthly, yearly, mês, ano)
- plan_selection: Usuário escolhe plano (pro, premium, básico, basico)
- cancel_upgrade: Usuário cancela (cancelar, cancel, não, nao, desistir, parar)
- continue_upgrade: Continuação do fluxo sem ação específica

Exemplos:
- "Sim" → payment_confirmation
- "Mensal" → frequency_selection  
- "Pro" → plan_selection
- "Cancelar" → cancel_upgrade
- "O que você acha?" → continue_upgrade`;

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Você é um analisador especializado em intenções de usuário em fluxos de upgrade. Seja preciso e consistente.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1,
      });

      const responseText = completion.choices[0]?.message?.content;
      if (responseText) {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsedResponse = JSON.parse(jsonMatch[0]);
          this.logger.log('🤖 Análise de intent:', parsedResponse);
          return {
            confidence: parsedResponse.confidence || 0,
            intent: parsedResponse.intent || 'continue_upgrade',
            reasoning: parsedResponse.reasoning || 'análise padrão'
          };
        }
      }

      // Fallback
      return {
        confidence: 0.5,
        intent: 'continue_upgrade',
        reasoning: 'análise padrão - resposta não reconhecida'
      };

    } catch (error) {
      this.logger.error('❌ Erro ao analisar intent de upgrade:', error);
      return {
        confidence: 0.3,
        intent: 'continue_upgrade',
        reasoning: 'erro na análise - usando fallback'
      };
    }
  }

  async detectNewPlanUpgradeIntent(text: string): Promise<{
    isUpgradeIntent: boolean;
    confidence: number;
    reasoning: string;
  }> {
    try {
      this.logger.log('🆕 Detectando novo intent de upgrade:', text);

      const prompt = `Analise a seguinte mensagem do usuário e determine se ela indica uma intenção de fazer upgrade de plano.

Mensagem: "${text}"

Responda apenas com um JSON no seguinte formato:
{
  "isUpgradeIntent": true/false,
  "confidence": 0.0-1.0,
  "reasoning": "explicação da análise"
}

Critérios para considerar como intent de upgrade:
- Palavras relacionadas a planos: upgrade, plano, assinar, assinatura, premium, pro
- Palavras relacionadas a melhorias: melhorar, evoluir, avançar, crescer
- Palavras relacionadas a recursos: mais, ilimitado, completo, avançado
- Perguntas sobre planos: "quais são os planos?", "como funciona o upgrade?"
- Expressões de interesse: "quero", "gostaria", "pode me mostrar"

Exemplos que DEVEM ser detectados:
- "Quero fazer upgrade"
- "Quais são os planos?"
- "Como funciona o premium?"
- "Gostaria de mais recursos"
- "Quero o plano pro"

Exemplos que NÃO devem ser detectados:
- "Gastei 50 reais"
- "Como está meu saldo?"
- "Quero ver meus gastos"`;

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Você é um detector especializado em identificar intenções de upgrade de plano. Seja preciso e consistente.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1,
      });

      const responseText = completion.choices[0]?.message?.content;
      if (responseText) {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsedResponse = JSON.parse(jsonMatch[0]);
          this.logger.log('🤖 Novo intent detectado:', parsedResponse);
          return {
            isUpgradeIntent: parsedResponse.isUpgradeIntent || false,
            confidence: parsedResponse.confidence || 0,
            reasoning: parsedResponse.reasoning || 'análise padrão'
          };
        }
      }

      // Fallback
      return {
        isUpgradeIntent: false,
        confidence: 0.3,
        reasoning: 'análise padrão - resposta não reconhecida'
      };

    } catch (error) {
      this.logger.error('❌ Erro ao detectar novo intent de upgrade:', error);
      return {
        isUpgradeIntent: false,
        confidence: 0.2,
        reasoning: 'erro na análise - usando fallback'
      };
    }
  }

  async detectPlanFrequencySelection(text: string): Promise<{
    frequency: 'monthly' | 'yearly' | null;
    confidence: number;
    reasoning: string;
  }> {
    try {
      this.logger.log('📅 Detectando seleção de frequência:', text);

      const prompt = `Analise a seguinte mensagem do usuário e determine se ele está escolhendo uma frequência de pagamento.

Mensagem: "${text}"

Responda apenas com um JSON no seguinte formato:
{
  "frequency": "monthly|yearly|null",
  "confidence": 0.0-1.0,
  "reasoning": "explicação da análise"
}

Critérios:
- monthly: mensal, monthly, mês, mês a mês, por mês
- yearly: anual, yearly, ano, ano inteiro, por ano, anual
- null: não especificou frequência

Exemplos:
- "Mensal" → monthly
- "Anual" → yearly
- "Por mês" → monthly
- "Ano inteiro" → yearly
- "Sim" → null
- "Ok" → null`;

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Você é um detector especializado em identificar escolhas de frequência de pagamento. Seja preciso e consistente.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1,
      });

      const responseText = completion.choices[0]?.message?.content;
      if (responseText) {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsedResponse = JSON.parse(jsonMatch[0]);
          this.logger.log('🤖 Frequência detectada:', parsedResponse);
          return {
            frequency: parsedResponse.frequency || null,
            confidence: parsedResponse.confidence || 0,
            reasoning: parsedResponse.reasoning || 'análise padrão'
          };
        }
      }

      // Fallback
      return {
        frequency: null,
        confidence: 0.3,
        reasoning: 'análise padrão - resposta não reconhecida'
      };

    } catch (error) {
      this.logger.error('❌ Erro ao detectar frequência:', error);
      return {
        frequency: null,
        confidence: 0.2,
        reasoning: 'erro na análise - usando fallback'
      };
    }
  }

  async detectPlanFromMessage(text: string): Promise<{
    planName: string | null;
    confidence: number;
    reasoning: string;
  }> {
    try {
      this.logger.log('📋 Detectando plano da mensagem:', text);

      const prompt = `Analise a seguinte mensagem do usuário e determine se ele está escolhendo um plano específico.

Mensagem: "${text}"

Responda apenas com um JSON no seguinte formato:
{
  "planName": "Pro|Premium|Free|null",
  "confidence": 0.0-1.0,
  "reasoning": "explicação da análise"
}

Critérios:
- Pro: pro, plano pro, plano profissional
- Premium: premium, plano premium, plano completo
- Free: free, gratuito, básico, plano básico, plano free
- null: não especificou plano

Exemplos:
- "Quero o Pro" → Pro
- "Premium" → Premium
- "O básico está bom" → Free
- "Sim" → null
- "Ok" → null`;

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Você é um detector especializado em identificar escolhas de planos. Seja preciso e consistente.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1,
      });

      const responseText = completion.choices[0]?.message?.content;
      if (responseText) {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsedResponse = JSON.parse(jsonMatch[0]);
          this.logger.log('🤖 Plano detectado:', parsedResponse);
          return {
            planName: parsedResponse.planName || null,
            confidence: parsedResponse.confidence || 0,
            reasoning: parsedResponse.reasoning || 'análise padrão'
          };
        }
      }

      // Fallback
      return {
        planName: null,
        confidence: 0.3,
        reasoning: 'análise padrão - resposta não reconhecida'
      };

    } catch (error) {
      this.logger.error('❌ Erro ao detectar plano:', error);
      return {
        planName: null,
        confidence: 0.2,
        reasoning: 'erro na análise - usando fallback'
      };
    }
  }










  // ===== NOVOS MÉTODOS PARA CHAT LAWX =====

  /**
   * Gera resposta jurídica baseada na jurisdição e tipo de consulta
   */
  async generateLegalResponse(
    message: string, 
    phoneNumber: string, 
    userId?: string,
    documentContent?: string
  ): Promise<string> {
    try {
      // Detectar jurisdição baseada no número de telefone
      const jurisdiction = this.jurisdictionService.detectJurisdiction(phoneNumber);
      this.logger.log(`Jurisdição detectada: ${jurisdiction.jurisdiction} para ${phoneNumber}`);

      // Validar limites de uso
      await this.validateUsageLimits(jurisdiction.jurisdiction, userId);

      // Determinar tipo de consulta jurídica
      const legalIntent = await this.detectLegalIntent(message, documentContent);
      this.logger.log(`Intent jurídico detectado: ${legalIntent.type}`);

      // Executar prompt jurídico apropriado
      const response = await this.executeLegalPrompt(
        legalIntent.type,
        jurisdiction.jurisdiction,
        {
          message,
          documentContent,
          jurisdiction: jurisdiction.jurisdiction,
          userId,
        }
      );

      // Contabilizar mensagem enviada
      await this.incrementMessageCount(jurisdiction.jurisdiction, userId);

      return response;
    } catch (error) {
      this.logger.error('Erro ao gerar resposta jurídica:', error);
      
      // Se for erro de limite, propagar para o WhatsAppService tratar
      if (error.message && error.message.includes('Limite de mensagens atingido')) {
        throw error;
      }
      
      // Para outros erros, retornar mensagem genérica
      return 'Desculpe, não consegui processar sua consulta jurídica. Pode tentar novamente?';
    }
  }

  /**
   * Detecta o tipo de consulta jurídica
   */
  private async detectLegalIntent(message: string, documentContent?: string): Promise<{
    type: string;
    confidence: number;
    reasoning: string;
  }> {
    try {
      const prompt = `Analise a seguinte mensagem e determine o tipo de consulta jurídica.

Mensagem: "${message}"
${documentContent ? `\nConteúdo do documento: "${documentContent}"` : ''}

Responda APENAS em JSON:
{
  "type": "contract_analysis|contract_drafting|petition_drafting|legal_opinion|consultation|document_review|clause_suggestion|risk_analysis|jurisprudence_search|legal_research",
  "confidence": 0.0-1.0,
  "reasoning": "explicação da análise"
}

Tipos de consulta:
- contract_analysis: Análise de contratos
- contract_drafting: Elaboração de contratos
- petition_drafting: Elaboração de petições
- legal_opinion: Parecer jurídico
- consultation: Consulta jurídica geral
- document_review: Revisão de documentos
- clause_suggestion: Sugestão de cláusulas
- risk_analysis: Análise de riscos
- jurisprudence_search: Busca de jurisprudência
- legal_research: Pesquisa jurídica`;

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Você é um especialista em classificar consultas jurídicas. Seja preciso e consistente.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1,
      });

      const responseText = completion.choices[0]?.message?.content;
      if (responseText) {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          this.logger.log('Intent jurídico detectado:', result);
          return result;
        }
      }

      // Fallback
      return {
        type: 'consultation',
        confidence: 0.5,
        reasoning: 'análise padrão - resposta não reconhecida'
      };
    } catch (error) {
      this.logger.error('Erro ao detectar intent jurídico:', error);
      return {
        type: 'consultation',
        confidence: 0.3,
        reasoning: 'erro na análise - usando fallback'
      };
    }
  }

  /**
   * Executa prompt jurídico específico
   */
  private async executeLegalPrompt(
    promptType: string,
    jurisdiction: string,
    context: {
      message: string;
      documentContent?: string;
      jurisdiction: string;
      userId?: string;
    }
  ): Promise<string> {
    try {
      // Buscar prompt ativo para a jurisdição
      const prompt = await this.legalPromptsService.getActivePromptByJurisdiction(jurisdiction);

      if (!prompt) {
        // Usar prompt genérico se não encontrar específico
        return await this.generateGenericLegalResponse(context.message, jurisdiction);
      }
      
      // Preparar variáveis para o prompt
      const variables = {
        message: context.message,
        document_content: context.documentContent || '',
        jurisdiction: context.jurisdiction,
        user_id: context.userId || '',
      };

      // Combinar o prompt base com a mensagem do usuário
      const processedPrompt = `${prompt.content}

CONSULTA DO USUÁRIO: ${context.message}
${context.documentContent ? `\nCONTEÚDO DO DOCUMENTO: ${context.documentContent}` : ''}

Por favor, responda à consulta do usuário de forma precisa e útil, seguindo as diretrizes estabelecidas acima.`;

      // Gerar resposta com IA
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `Você é um assistente jurídico especializado em ${jurisdiction}. Seja preciso, profissional e útil.`
          },
          {
            role: 'user',
            content: processedPrompt
          }
        ],
        temperature: 0.3,
      });

      const response = completion.choices[0]?.message?.content;
      if (response) {
        this.logger.log('Resposta jurídica gerada com sucesso');
        return response;
      }

      throw new Error('Resposta vazia da IA');
    } catch (error) {
      this.logger.error('Erro ao executar prompt jurídico:', error);
      return await this.generateGenericLegalResponse(context.message, jurisdiction);
    }
  }

  /**
   * Gera resposta jurídica genérica quando não há prompt específico
   */
  private async generateGenericLegalResponse(message: string, jurisdiction: string): Promise<string> {
    const prompt = `Você é um assistente jurídico especializado em ${jurisdiction}. 
    
Responda à seguinte consulta de forma profissional e útil:

"${message}"

Forneça uma resposta jurídica adequada, considerando a legislação de ${jurisdiction}.
Seja claro, objetivo e sempre mencione que é importante consultar um advogado para casos específicos.`;

    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `Você é um assistente jurídico especializado em ${jurisdiction}. Seja profissional e útil.`
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.3,
      });

      const response = completion.choices[0]?.message?.content;
      return response || 'Desculpe, não consegui processar sua consulta jurídica.';
    } catch (error) {
      this.logger.error('Erro ao gerar resposta jurídica genérica:', error);
      return 'Desculpe, não consegui processar sua consulta jurídica. Pode reformular sua pergunta?';
    }
  }

  /**
   * Valida limites de uso baseado na jurisdição
   */
  private async validateUsageLimits(jurisdiction: string, userId?: string): Promise<void> {
    try {
      const limitControlType = this.jurisdictionService.getLimitControlType(jurisdiction);
      
      if (limitControlType === 'teams' && userId) {
        // Para Brasil - validar via Supabase teams
        const validation = await this.teamsService.validateTeamLimit(userId);
        if (!validation.canSendMessage) {
          throw new Error(`Limite de mensagens atingido. Você usou ${validation.currentUsage} de ${validation.limit} mensagens permitidas.`);
        }
      } else if (limitControlType === 'local' && userId) {
        // Para Portugal/Espanha - validar via Prisma
        const user = await this.prismaService.findUserByPhone(userId);
        if (user && user.messagesCount >= 100) { // Limite padrão para PT/ES
          throw new Error('Limite de mensagens atingido. Entre em contato para upgrade do seu plano.');
        }
      }
    } catch (error) {
      this.logger.error('Erro ao validar limites de uso:', error);
      throw error;
    }
  }

  /**
   * Incrementa contador de mensagens baseado na jurisdição
   */
  private async incrementMessageCount(jurisdiction: string, userId?: string): Promise<void> {
    try {
      const limitControlType = this.jurisdictionService.getLimitControlType(jurisdiction);
      
      if (limitControlType === 'teams' && userId) {
        // Para Brasil - incrementar via Supabase teams
        await this.teamsService.incrementTeamUsage(userId);
      } else if (limitControlType === 'local' && userId) {
        // Para Portugal/Espanha - incrementar via Prisma
        await this.prismaService.incrementUserMessages(userId);
      }
    } catch (error) {
      this.logger.error('Erro ao incrementar contador de mensagens:', error);
      // Não lançar erro para não interromper o fluxo
    }
  }

  /**
   * Analisa documento jurídico (imagem ou texto)
   */
  async analyzeLegalDocument(
    content: string | Buffer,
    jurisdiction: string,
    userId?: string
  ): Promise<{
    analysis: string;
    type: string;
    risks: string[];
    suggestions: string[];
  }> {
    try {
      // Validar limites
      await this.validateUsageLimits(jurisdiction, userId);

      let documentText = '';
      
      if (Buffer.isBuffer(content)) {
        // Se for imagem, extrair texto com OCR
        documentText = await this.extractTextFromImage(content);
      } else {
        documentText = content;
      }

      // Analisar documento com IA
      const analysis = await this.performLegalDocumentAnalysis(documentText, jurisdiction);
      
      // Incrementar contador
      await this.incrementMessageCount(jurisdiction, userId);

      return analysis;
    } catch (error) {
      this.logger.error('Erro ao analisar documento jurídico:', error);
      throw error;
    }
  }

  /**
   * Extrai texto de imagem usando IA (OpenAI Vision + Gemini + OCR como fallback)
   */
  private async extractTextFromImage(imageBuffer: Buffer): Promise<string> {
    try {
      this.logger.log('🖼️ Extraindo texto de imagem com IA...');
      
      // Validar e otimizar imagem
      const optimizedBuffer = await this.optimizeImageForTextExtraction(imageBuffer);
      
      // Tentar primeiro com OpenAI Vision API
      try {
        const text = await this.extractTextWithOpenAIVision(optimizedBuffer);
        if (text && text.trim().length > 0) {
          this.logger.log('✅ Texto extraído com OpenAI Vision');
          return text;
        }
      } catch (visionError) {
        this.logger.warn('⚠️ Falha com OpenAI Vision, tentando Gemini:', visionError);
      }
      
      // Tentar com Gemini como segunda opção
      try {
        const text = await this.extractTextWithGemini(optimizedBuffer);
        if (text && text.trim().length > 0) {
          this.logger.log('✅ Texto extraído com Gemini');
          return text;
        }
      } catch (geminiError) {
        this.logger.warn('⚠️ Falha com Gemini, tentando OCR:', geminiError);
      }
      
      // Fallback para OCR com Tesseract
      this.logger.log('🔄 Usando OCR como fallback...');
      const { data: { text } } = await Tesseract.recognize(optimizedBuffer, 'por');
      
      if (!text || text.trim().length === 0) {
        throw new Error('Nenhum texto foi extraído da imagem');
      }
      
      this.logger.log('✅ Texto extraído com OCR');
      return text.trim();
    } catch (error) {
      this.logger.error('❌ Erro ao extrair texto da imagem:', error);
      throw new Error('Não foi possível extrair texto da imagem');
    }
  }

  /**
   * Otimiza imagem para melhor extração de texto
   */
  private async optimizeImageForTextExtraction(imageBuffer: Buffer): Promise<Buffer> {
    try {
      // Verificar se já é um formato otimizado
      const format = this.detectImageFormat(imageBuffer);
      if (format === 'jpeg' || format === 'png') {
        // Aplicar melhorias de contraste e nitidez para melhor OCR
        const optimizedBuffer = await sharp(imageBuffer)
          .resize(null, 2000, { // Redimensionar mantendo proporção, altura máxima 2000px
            withoutEnlargement: true,
            fit: 'inside'
          })
          .sharpen() // Aumentar nitidez
          .normalize() // Normalizar contraste
          .jpeg({ quality: 90 }) // Converter para JPEG com alta qualidade
          .toBuffer();
        
        this.logger.log('✅ Imagem otimizada para extração de texto');
        return optimizedBuffer;
      }
      
      // Se não conseguir otimizar, retornar original
      return imageBuffer;
    } catch (error) {
      this.logger.warn('⚠️ Erro ao otimizar imagem, usando original:', error);
      return imageBuffer;
    }
  }

  /**
   * Detecta o formato da imagem baseado nos primeiros bytes
   */
  private detectImageFormat(buffer: Buffer): string {
    const firstBytes = buffer.slice(0, 4);
    
    // JPEG
    if (firstBytes[0] === 0xFF && firstBytes[1] === 0xD8 && firstBytes[2] === 0xFF) {
      return 'jpeg';
    }
    
    // PNG
    if (firstBytes[0] === 0x89 && firstBytes[1] === 0x50 && firstBytes[2] === 0x4E && firstBytes[3] === 0x47) {
      return 'png';
    }
    
    // GIF
    if (firstBytes[0] === 0x47 && firstBytes[1] === 0x49 && firstBytes[2] === 0x46) {
      return 'gif';
    }
    
    // WebP
    if (firstBytes[0] === 0x52 && firstBytes[1] === 0x49 && firstBytes[2] === 0x46 && firstBytes[3] === 0x46) {
      return 'webp';
    }
    
    // Se não conseguir detectar, assumir JPEG
    return 'jpeg';
  }

  /**
   * Extrai texto de imagem usando OpenAI Vision API
   */
  private async extractTextWithOpenAIVision(imageBuffer: Buffer): Promise<string> {
    try {
      const base64Image = imageBuffer.toString('base64');
      
      const prompt = `Extraia todo o texto visível desta imagem, focando especificamente em documentos jurídicos e legais.
      
      Instruções para documentos jurídicos:
      - Extraia APENAS o texto, sem interpretação ou análise jurídica
      - Mantenha a formatação original (quebras de linha, espaçamentos, parágrafos)
      - Se houver tabelas, mantenha a estrutura exata
      - Para processos judiciais: extraia número do processo, partes envolvidas, juízo, data, tipo de ação
      - Para jurisprudências: extraia tribunal, relator, data do julgamento, ementa, dispositivo
      - Para contratos: extraia cláusulas, partes contratantes, valores, prazos, condições
      - Para petições: extraia cabeçalho, fundamentos, pedidos, assinaturas
      - Para pareceres: extraia consulta, análise, conclusões, recomendações
      - Para sentenças: extraia relatório, fundamentação, dispositivo, data
      - Para leis e decretos: extraia artigo, parágrafo, inciso, alínea
      - Se houver números de processo, CNPJ, CPF, OAB, extraia exatamente como aparecem
      - Se houver datas, valores monetários, prazos, extraia com precisão
      - Se houver texto em português, inglês ou espanhol, extraia todos os idiomas
      - Se não houver texto visível, responda "Nenhum texto encontrado"
      
      Tipos de documentos jurídicos esperados:
      - Processos judiciais e autos
      - Jurisprudências e precedentes
      - Contratos e acordos
      - Petições e alegações
      - Pareceres jurídicos
      - Sentenças e decisões
      - Leis, decretos e regulamentos
      - Certidões e atestados
      - Procurações e mandatos
      - Escrituras e instrumentos públicos
      
      Responda APENAS com o texto extraído, sem comentários adicionais.`;

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Você é um especialista em extração de texto de documentos jurídicos e legais. Extraia apenas o texto visível, sem interpretação jurídica, focando em processos, jurisprudências, contratos e documentos legais.'
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: prompt
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`
                }
              }
            ]
          }
        ],
        temperature: 0.1,
      });

      const responseText = completion.choices[0]?.message?.content;
      if (responseText && responseText.trim() !== 'Nenhum texto encontrado') {
        return responseText.trim();
      }
      
      throw new Error('Nenhum texto encontrado na imagem');
    } catch (error) {
      this.logger.error('❌ Erro na OpenAI Vision API:', error);
      throw error;
    }
  }

  /**
   * Extrai texto de imagem usando Gemini como alternativa
   */
  private async extractTextWithGemini(imageBuffer: Buffer): Promise<string> {
    try {
      const base64Image = imageBuffer.toString('base64');
      
      const prompt = `Extraia todo o texto visível desta imagem, focando especificamente em documentos jurídicos e legais.
      
      Instruções para documentos jurídicos:
      - Extraia APENAS o texto, sem interpretação ou análise jurídica
      - Mantenha a formatação original (quebras de linha, espaçamentos, parágrafos)
      - Se houver tabelas, mantenha a estrutura exata
      - Para processos judiciais: extraia número do processo, partes envolvidas, juízo, data, tipo de ação
      - Para jurisprudências: extraia tribunal, relator, data do julgamento, ementa, dispositivo
      - Para contratos: extraia cláusulas, partes contratantes, valores, prazos, condições
      - Para petições: extraia cabeçalho, fundamentos, pedidos, assinaturas
      - Para pareceres: extraia consulta, análise, conclusões, recomendações
      - Para sentenças: extraia relatório, fundamentação, dispositivo, data
      - Para leis e decretos: extraia artigo, parágrafo, inciso, alínea
      - Se houver números de processo, CNPJ, CPF, OAB, extraia exatamente como aparecem
      - Se houver datas, valores monetários, prazos, extraia com precisão
      - Se houver texto em português, inglês ou espanhol, extraia todos os idiomas
      - Se não houver texto visível, responda "Nenhum texto encontrado"
      
      Tipos de documentos jurídicos esperados:
      - Processos judiciais e autos
      - Jurisprudências e precedentes
      - Contratos e acordos
      - Petições e alegações
      - Pareceres jurídicos
      - Sentenças e decisões
      - Leis, decretos e regulamentos
      - Certidões e atestados
      - Procurações e mandatos
      - Escrituras e instrumentos públicos
      
      Responda APENAS com o texto extraído, sem comentários adicionais.`;

      const result = await this.gemini.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const response = await result.generateContent([
        prompt,
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: base64Image
          }
        }
      ]);
      
      const responseText = response.response.text();
      if (responseText && responseText.trim() !== 'Nenhum texto encontrado') {
        return responseText.trim();
      }
      
      throw new Error('Nenhum texto encontrado na imagem');
    } catch (error) {
      this.logger.error('❌ Erro na Gemini API:', error);
      throw error;
    }
  }

  /**
   * Detecta se uma mensagem é confirmação ou negação baseado no idioma
   */
  async detectConfirmationOrDenial(
    message: string,
    jurisdiction: string
  ): Promise<{
    isConfirmation: boolean;
    isDenial: boolean;
    confidence: number;
    reasoning: string;
  }> {
    try {
      this.logger.log(`🤖 Detectando confirmação/negação para ${jurisdiction}:`, message);

      const languageMap = {
        'BR': 'português brasileiro',
        'PT': 'português europeu', 
        'ES': 'espanhol'
      };

      const language = languageMap[jurisdiction] || 'português brasileiro';

      const prompt = `Analise a seguinte mensagem do usuário e determine se é uma confirmação ou negação.

Mensagem: "${message}"
Idioma: ${language}

Responda APENAS em JSON:
{
  "isConfirmation": true/false,
  "isDenial": true/false,
  "confidence": 0.0-1.0,
  "reasoning": "explicação da análise"
}

Critérios para confirmação (${language}):
- Palavras: sim, yes, s, sí, si, claro, certo, ok, pode ser, vamos, prosseguir, continuar, confirmo, aceito, concordo
- Frases: "pode ser", "vamos lá", "pode continuar", "está bem", "tudo certo", "pode prosseguir"
- Expressões afirmativas: "quero", "desejo", "gostaria de", "aceito", "concordo"

Critérios para negação (${language}):
- Palavras: não, nao, no, n, nunca, jamais, recuso, cancelo, desisto, paro, pare
- Frases: "não quero", "não desejo", "não aceito", "não concordo", "não pode", "não vamos"
- Expressões negativas: "não gosto", "não quero", "não aceito", "recuso", "cancelo"

Exemplos de confirmação:
- "Sim" → isConfirmation: true, isDenial: false
- "Ok, pode ser" → isConfirmation: true, isDenial: false
- "Vamos lá" → isConfirmation: true, isDenial: false
- "Aceito" → isConfirmation: true, isDenial: false

Exemplos de negação:
- "Não" → isConfirmation: false, isDenial: true
- "Não quero" → isConfirmation: false, isDenial: true
- "Cancelar" → isConfirmation: false, isDenial: true
- "Desisto" → isConfirmation: false, isDenial: true

Se não for nem confirmação nem negação clara, ambos devem ser false.`;

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: `Você é um especialista em detectar confirmações e negações em ${language}. Seja preciso e consistente.`
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1,
      });

      const responseText = completion.choices[0]?.message?.content;
      if (responseText) {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          this.logger.log('🤖 Detecção de confirmação/negação:', result);
          return {
            isConfirmation: result.isConfirmation || false,
            isDenial: result.isDenial || false,
            confidence: result.confidence || 0,
            reasoning: result.reasoning || 'análise padrão'
          };
        }
      }

      // Fallback
      return {
        isConfirmation: false,
        isDenial: false,
        confidence: 0.3,
        reasoning: 'análise padrão - resposta não reconhecida'
      };

    } catch (error) {
      this.logger.error('❌ Erro ao detectar confirmação/negação:', error);
      return {
        isConfirmation: false,
        isDenial: false,
        confidence: 0.2,
        reasoning: 'erro na análise - usando fallback'
      };
    }
  }

  /**
   * Realiza análise jurídica do documento
   */
  private async performLegalDocumentAnalysis(
    documentText: string,
    jurisdiction: string
  ): Promise<{
    analysis: string;
    type: string;
    risks: string[];
    suggestions: string[];
  }> {
    const prompt = `Analise o seguinte documento jurídico considerando a legislação de ${jurisdiction}:

"${documentText}"

Forneça uma análise estruturada em JSON:
{
  "analysis": "análise detalhada do documento",
  "type": "tipo de documento (contrato, petição, parecer, etc.)",
  "risks": ["risco 1", "risco 2", "risco 3"],
  "suggestions": ["sugestão 1", "sugestão 2", "sugestão 3"]
}

Seja específico e prático nas recomendações.`;

    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `Você é um especialista em análise de documentos jurídicos para ${jurisdiction}. Seja preciso e prático.`
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.2,
      });

      const responseText = completion.choices[0]?.message?.content;
      if (responseText) {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          return result;
        }
      }

      throw new Error('Resposta inválida da IA');
    } catch (error) {
      this.logger.error('Erro na análise jurídica:', error);
      throw error;
    }
  }
} 
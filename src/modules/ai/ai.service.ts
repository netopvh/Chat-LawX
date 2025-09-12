import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import * as Tesseract from 'tesseract.js';
import * as fs from 'fs';
import * as path from 'path';
import * as sharp from 'sharp';

export interface ExtractedData {
  amount: number;
  original_amount?: number;
  discount_amount?: number;
  category: string;
  date: string;
  description: string;
  payment_method?: string;
  store_name?: string;
  store_cnpj?: string;
  store_address?: string;
  document_type?: string;
  document_number?: string;
  // Novos campos para classificação
  document_classification: 'revenue' | 'expense';
  revenue_type?: string; // 'salary', 'freelance', 'sale', 'investment', 'other'
  expense_type?: string; // 'purchase', 'bill', 'service', 'other'
  payer_name?: string; // para receitas
  payer_cnpj?: string; // para receitas
  payer_address?: string; // para receitas
  source?: string; // origem da receita
}

export interface ImageValidationResult {
  isValid: boolean;
  reason?: string;
  confidence?: number;
}

export interface DocumentClassification {
  type: 'revenue' | 'expense';
  confidence: number;
  reason: string;
  documentCategory: string; // 'salary', 'freelance', 'purchase', 'bill', etc.
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private gemini: GoogleGenerativeAI;
  private openai: OpenAI;

  constructor(private configService: ConfigService) {
    this.gemini = new GoogleGenerativeAI(this.configService.get('GEMINI_API_KEY'));
    this.openai = new OpenAI({
      apiKey: this.configService.get('OPENAI_API_KEY'),
    });
  }

  /**
   * Obtém a data atual no timezone de São Paulo (America/Sao_Paulo)
   * @returns Data no formato YYYY-MM-DD
   */
  private getCurrentDateInSaoPaulo(): string {
    const now = new Date();
    // Ajustar para o timezone de São Paulo (UTC-3)
    const saoPauloOffset = -3 * 60; // -3 horas em minutos
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const saoPauloTime = new Date(utc + (saoPauloOffset * 60000));
    return saoPauloTime.toISOString().split('T')[0];
  }

  async extractDataFromImage(imageBuffer: Buffer): Promise<ExtractedData> {
    try {
      // Validar buffer de entrada
      if (!imageBuffer || imageBuffer.length === 0) {
        throw new Error('Buffer de imagem vazio ou inválido');
      }

      this.logger.log('📊 Tamanho do buffer de entrada:', imageBuffer.length, 'bytes');

      // Primeiro, validar se a imagem é um comprovante válido
      const validation = await this.validateReceiptImage(imageBuffer);
      if (!validation.isValid) {
        throw new Error(`Imagem inválida: ${validation.reason}`);
      }

      // Classificar o tipo de documento (receita ou despesa)
      this.logger.log('🔍 Classificando tipo de documento...');
      const classification = await this.classifyDocument(imageBuffer);
      this.logger.log('✅ Classificação:', classification);

      // Verificar formato da imagem pelos primeiros bytes
      const firstBytes = imageBuffer.slice(0, 4);
      const isJPEG = firstBytes[0] === 0xFF && firstBytes[1] === 0xD8 && firstBytes[2] === 0xFF;
      const isPNG = firstBytes[0] === 0x89 && firstBytes[1] === 0x50 && firstBytes[2] === 0x4E && firstBytes[3] === 0x47;
      
      this.logger.log('🔍 Primeiros bytes:', firstBytes.toString('hex'));
      this.logger.log('🔍 Formato detectado - JPEG:', isJPEG, 'PNG:', isPNG);

      // Se a imagem não é um formato válido, tentar converter
      if (!isJPEG && !isPNG) {
        this.logger.warn('⚠️ Formato de imagem não reconhecido, tentando converter...');
        try {
          imageBuffer = await this.convertImageToJPEG(imageBuffer);
          this.logger.log('✅ Imagem convertida para JPEG');
        } catch (convertError) {
          this.logger.warn('⚠️ Falha na conversão, tentando processar original:', convertError);
        }
      }

      // Extrair dados baseado na classificação
      let extractedData: ExtractedData;
      
      if (classification.type === 'revenue') {
        // Extrair dados específicos para receitas
        extractedData = await this.extractRevenueData(imageBuffer, classification);
      } else {
        // Extrair dados específicos para despesas
        extractedData = await this.extractExpenseData(imageBuffer, classification);
      }

      return extractedData;
    } catch (error) {
      this.logger.error('❌ Erro ao processar imagem:', error);
      
      // Se for erro de validação, re-lançar o erro
      if (error.message.includes('Imagem inválida:')) {
        throw error;
      }
      
      // Para outros erros, retornar dados padrão
      return this.extractDataManually('Erro no processamento da imagem');
    }
  }

  async validateReceiptImage(imageBuffer: Buffer): Promise<ImageValidationResult> {
    try {
      const base64Image = imageBuffer.toString('base64');
      
      const validationPrompt = `
        Analise esta imagem e determine se é um comprovante de pagamento, boleto, nota fiscal, cupom fiscal, recibo ou documento financeiro válido.
        
        Considere como VÁLIDO se a imagem contém:
        - Comprovantes de pagamento (PIX, cartão, etc.)
        - Boletos bancários
        - Notas fiscais (NFC-e, NFe)
        - Cupons fiscais
        - Recibos de pagamento
        - Extratos bancários
        - Comprovantes de transferência
        - Faturas de cartão
        - Comprovantes de compra online
        - Notas de restaurante/bar
        - Comprovantes de serviços
        
        Considere como INVÁLIDO se a imagem contém:
        - Selfies
        - Fotos de pessoas
        - Paisagens
        - Screenshots de redes sociais
        - Imagens de entretenimento
        - Documentos pessoais (RG, CPF, etc.)
        - Imagens sem relação financeira
        
        Responda APENAS em JSON no seguinte formato:
        {
          "isValid": true/false,
          "reason": "Explicação detalhada do motivo",
          "confidence": 0.95
        }
        
        Seja rigoroso na validação. Só considere válido se for claramente um documento financeiro.
      `;

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Você é um validador especializado em documentos financeiros. Seja rigoroso e preciso.'
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: validationPrompt
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
      if (responseText) {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const validation = JSON.parse(jsonMatch[0]);
          this.logger.log('✅ Validação concluída:', validation);
          return validation;
        }
      }
      
      // Se não conseguir extrair JSON, tentar com Gemini
      return await this.validateReceiptImageWithGemini(imageBuffer);
    } catch (error) {
      this.logger.warn('⚠️ Falha na validação com OpenAI, tentando Gemini:', error);
      return await this.validateReceiptImageWithGemini(imageBuffer);
    }
  }

  private async validateReceiptImageWithGemini(imageBuffer: Buffer): Promise<ImageValidationResult> {
    try {
      const base64Image = imageBuffer.toString('base64');
      
      const validationPrompt = `
        Analise esta imagem e determine se é um comprovante de pagamento, boleto, nota fiscal, cupom fiscal, recibo ou documento financeiro válido.
        
        Considere como VÁLIDO se a imagem contém:
        - Comprovantes de pagamento (PIX, cartão, etc.)
        - Boletos bancários
        - Notas fiscais (NFC-e, NFe)
        - Cupons fiscais
        - Recibos de pagamento
        - Extratos bancários
        - Comprovantes de transferência
        - Faturas de cartão
        - Comprovantes de compra online
        - Notas de restaurante/bar
        - Comprovantes de serviços
        
        Considere como INVÁLIDO se a imagem contém:
        - Selfies
        - Fotos de pessoas
        - Paisagens
        - Screenshots de redes sociais
        - Imagens de entretenimento
        - Documentos pessoais (RG, CPF, etc.)
        - Imagens sem relação financeira
        
        Responda APENAS em JSON no seguinte formato:
        {
          "isValid": true/false,
          "reason": "Explicação detalhada do motivo",
          "confidence": 0.95
        }
        
        Seja rigoroso na validação. Só considere válido se for claramente um documento financeiro.
      `;

      const result = await this.gemini.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const response = await result.generateContent([
        validationPrompt,
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: base64Image
          }
        }
      ]);
      
      const responseText = response.response.text();
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const validation = JSON.parse(jsonMatch[0]);
        this.logger.log('✅ Validação concluída com Gemini:', validation);
        return validation;
      }
      
      // Se não conseguir extrair JSON, retornar inválido por segurança
      return {
        isValid: false,
        reason: 'Não foi possível validar a imagem. Por favor, envie um comprovante de pagamento válido.',
        confidence: 0.5
      };
    } catch (error) {
      this.logger.error('❌ Erro na validação com Gemini:', error);
      return {
        isValid: false,
        reason: 'Erro na validação da imagem. Por favor, envie um comprovante de pagamento válido.',
        confidence: 0.0
      };
    }
  }

  async classifyDocument(imageBuffer: Buffer): Promise<DocumentClassification> {
    try {
      const base64Image = imageBuffer.toString('base64');
      
      const classificationPrompt = `
        Analise esta imagem e determine se representa uma RECEITA ou DESPESA.

        RECEITA = Dinheiro ENTRANDO na conta (salário, pagamento recebido, venda, etc.)
        DESPESA = Dinheiro SAINDO da conta (compra, pagamento feito, boleto pago, etc.)

        Considere:
        - Palavras-chave: "recebido", "pago", "crédito", "débito", "entrada", "saída"
        - Contexto: quem está pagando para quem
        - Tipo de documento: holerite (receita) vs comprovante de compra (despesa)
        - Valores: positivos vs negativos
        - Fluxo: entrada vs saída de dinheiro

        Categorias de RECEITA:
        - salary: Salário, contracheque, holerite
        - freelance: Pagamento por serviço, nota fiscal de serviço
        - sale: Venda de produto, nota fiscal de venda
        - investment: Rendimentos, dividendos, juros
        - refund: Reembolso, estorno
        - transfer: Transferência recebida, PIX recebido
        - rent: Aluguel recebido
        - commission: Comissão, bônus
        - other: Outras receitas

        Categorias de DESPESA:
        - purchase: Compra de produto, nota fiscal de compra
        - bill: Conta, boleto, fatura
        - service: Serviço contratado
        - transfer: Transferência enviada, PIX enviado
        - other: Outras despesas

        Responda APENAS em JSON no seguinte formato:
        {
          "type": "revenue" | "expense",
          "confidence": 0.95,
          "reason": "Explicação detalhada do motivo",
          "documentCategory": "salary|freelance|sale|investment|refund|transfer|rent|commission|other|purchase|bill|service|transfer|other"
        }

        Seja rigoroso na classificação. Analise cuidadosamente o contexto e fluxo do dinheiro.
      `;

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Você é um classificador especializado em documentos financeiros. Seja preciso e rigoroso.'
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: classificationPrompt
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
      if (responseText) {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const classification = JSON.parse(jsonMatch[0]);
          this.logger.log('✅ Classificação concluída:', classification);
          return classification;
        }
      }
      
      // Se não conseguir extrair JSON, tentar com Gemini
      return await this.classifyDocumentWithGemini(imageBuffer);
    } catch (error) {
      this.logger.warn('⚠️ Falha na classificação com OpenAI, tentando Gemini:', error);
      return await this.classifyDocumentWithGemini(imageBuffer);
    }
  }

  private async classifyDocumentWithGemini(imageBuffer: Buffer): Promise<DocumentClassification> {
    try {
      const base64Image = imageBuffer.toString('base64');
      
      const classificationPrompt = `
        Analise esta imagem e determine se representa uma RECEITA ou DESPESA.

        RECEITA = Dinheiro ENTRANDO na conta (salário, pagamento recebido, venda, etc.)
        DESPESA = Dinheiro SAINDO da conta (compra, pagamento feito, boleto pago, etc.)

        Considere:
        - Palavras-chave: "recebido", "pago", "crédito", "débito", "entrada", "saída"
        - Contexto: quem está pagando para quem
        - Tipo de documento: holerite (receita) vs comprovante de compra (despesa)
        - Valores: positivos vs negativos
        - Fluxo: entrada vs saída de dinheiro

        Categorias de RECEITA:
        - salary: Salário, contracheque, holerite
        - freelance: Pagamento por serviço, nota fiscal de serviço
        - sale: Venda de produto, nota fiscal de venda
        - investment: Rendimentos, dividendos, juros
        - refund: Reembolso, estorno
        - transfer: Transferência recebida, PIX recebido
        - rent: Aluguel recebido
        - commission: Comissão, bônus
        - other: Outras receitas

        Categorias de DESPESA:
        - purchase: Compra de produto, nota fiscal de compra
        - bill: Conta, boleto, fatura
        - service: Serviço contratado
        - transfer: Transferência enviada, PIX enviado
        - other: Outras despesas

        Responda APENAS em JSON no seguinte formato:
        {
          "type": "revenue" | "expense",
          "confidence": 0.95,
          "reason": "Explicação detalhada do motivo",
          "documentCategory": "salary|freelance|sale|investment|refund|transfer|rent|commission|other|purchase|bill|service|transfer|other"
        }

        Seja rigoroso na classificação. Analise cuidadosamente o contexto e fluxo do dinheiro.
      `;

      const result = await this.gemini.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const response = await result.generateContent([
        classificationPrompt,
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: base64Image
          }
        }
      ]);
      
      const responseText = response.response.text();
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const classification = JSON.parse(jsonMatch[0]);
        this.logger.log('✅ Classificação concluída com Gemini:', classification);
        return classification;
      }
      
      // Se não conseguir extrair JSON, retornar classificação padrão
      return {
        type: 'expense',
        confidence: 0.5,
        reason: 'Não foi possível classificar o documento. Assumindo como despesa por padrão.',
        documentCategory: 'other'
      };
    } catch (error) {
      this.logger.error('❌ Erro na classificação com Gemini:', error);
      return {
        type: 'expense',
        confidence: 0.0,
        reason: 'Erro na classificação do documento. Assumindo como despesa por padrão.',
        documentCategory: 'other'
      };
    }
  }

  private async extractDataWithOpenAIVision(imageBuffer: Buffer): Promise<ExtractedData> {
    try {
      const base64Image = imageBuffer.toString('base64');
      
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Você é um assistente que extrai dados financeiros de imagens de comprovantes. Responda apenas em JSON válido.'
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Extraia do comprovante os seguintes dados:
- Valor final pago (amount)
- Valor original antes de descontos (original_amount, se houver desconto)
- Valor do desconto (discount_amount, se houver)
- Categoria do gasto (ex: Alimentação, Transporte, Lazer, Saúde, Educação, Moradia, Outros)
- Data da compra (formato YYYY-MM-DD)
- Descrição do que foi comprado
- Forma de pagamento (PIX, cartão, dinheiro, etc.)
- Nome da loja/estabelecimento
- CNPJ da loja (se visível)
- Endereço da loja (se visível)
- Tipo de documento (NFC-e, cupom, etc.)
- Número do documento fiscal

Considere descontos, promoções e formas de pagamento. Se houver desconto, calcule o valor original e o desconto aplicado.

Responda APENAS em JSON no seguinte formato:
{
  "amount": 0.00,
  "original_amount": 0.00,
  "discount_amount": 0.00,
  "category": "Categoria",
  "date": "YYYY-MM-DD",
  "description": "Descrição do gasto",
  "payment_method": "Forma de pagamento",
  "store_name": "Nome da loja",
  "store_cnpj": "CNPJ da loja",
  "store_address": "Endereço da loja",
  "document_type": "Tipo de documento",
  "document_number": "Número do documento"
}`
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
      if (responseText) {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const data = JSON.parse(jsonMatch[0]);
          this.logger.log('✅ Dados extraídos com OpenAI Vision');
          
          // Adicionar campos obrigatórios com valores padrão
          return {
            ...data,
            document_classification: 'expense', // Será sobrescrito pelos métodos específicos
            expense_type: 'purchase',
          };
        }
      }
      
      throw new Error('Resposta inválida da OpenAI Vision API');
    } catch (error) {
      this.logger.error('❌ Erro na OpenAI Vision API:', error);
      throw error;
    }
  }

  private async extractDataWithTesseract(imageBuffer: Buffer): Promise<ExtractedData> {
    // Criar diretório temporário se não existir
    const tempDir = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir);
    }

    // Salvar imagem temporariamente
    const tempFile = path.join(tempDir, `receipt_${Date.now()}.jpg`);
    fs.writeFileSync(tempFile, imageBuffer);
    
    this.logger.log('💾 Imagem salva temporariamente:', tempFile);
    this.logger.log('📊 Tamanho da imagem:', imageBuffer.length, 'bytes');

    // Verificar se o arquivo foi criado corretamente
    if (!fs.existsSync(tempFile)) {
      throw new Error('Arquivo temporário não foi criado');
    }

    const fileStats = fs.statSync(tempFile);
    this.logger.log('📁 Arquivo criado, tamanho:', fileStats.size, 'bytes');

    // Verificar se o arquivo tem conteúdo
    if (fileStats.size === 0) {
      throw new Error('Arquivo temporário está vazio');
    }

    // Extrair texto da imagem usando Tesseract
    this.logger.log('🔍 Iniciando OCR com Tesseract...');
    
    try {
      const { data: { text } } = await Tesseract.recognize(tempFile, 'por', {
        logger: m => this.logger.log('🔍 Tesseract:', m.status, m.progress)
      });
      
      // Deletar arquivo temporário
      fs.unlinkSync(tempFile);
      
      this.logger.log('📝 Texto extraído da imagem:', text);

      if (!text || text.trim().length === 0) {
        this.logger.warn('⚠️ Nenhum texto foi extraído da imagem');
        return this.extractDataManually('Imagem sem texto legível');
      }

      // Processar texto com IA para extrair dados estruturados
      const extractedData = await this.processTextWithAI(text);
      
      return extractedData;
    } catch (tesseractError) {
      this.logger.error('❌ Erro no Tesseract:', tesseractError);
      
      // Tentar com configurações diferentes
      this.logger.log('🔄 Tentando OCR com configurações alternativas...');
      
      try {
        const { data: { text } } = await Tesseract.recognize(tempFile, 'eng', {
          logger: m => this.logger.log('🔍 Tesseract (eng):', m.status, m.progress)
        });
        
        // Deletar arquivo temporário
        fs.unlinkSync(tempFile);
        
        this.logger.log('📝 Texto extraído (inglês):', text);

        if (!text || text.trim().length === 0) {
          this.logger.warn('⚠️ Nenhum texto foi extraído mesmo com inglês');
          return this.extractDataManually('Imagem sem texto legível');
        }

        const extractedData = await this.processTextWithAI(text);
        return extractedData;
      } catch (secondError) {
        this.logger.error('❌ Erro no Tesseract (segunda tentativa):', secondError);
        
        // Deletar arquivo temporário se ainda existir
        try {
          if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
          }
        } catch (cleanupError) {
          this.logger.error('❌ Erro ao limpar arquivo temporário:', cleanupError);
        }
        
        // Retornar dados padrão em vez de lançar erro
        return this.extractDataManually('Falha no OCR');
      }
    }
  }

  private async processTextWithAI(text: string): Promise<ExtractedData> {
    const prompt = `
      Extraia do texto abaixo os seguintes dados:
      - Valor final pago (amount)
      - Valor original antes de descontos (original_amount, se houver desconto)
      - Valor do desconto (discount_amount, se houver)
      - Categoria do gasto (ex: Alimentação, Transporte, Lazer, Saúde, Educação, Moradia, Outros)
      - Data (formato YYYY-MM-DD, se não encontrar use a data atual)
      - Descrição (resumo do que foi comprado)
      - Forma de pagamento (PIX, cartão, dinheiro, etc.)
      - Nome da loja/estabelecimento
      - CNPJ da loja (se visível)
      - Endereço da loja (se visível)
      - Tipo de documento (NFC-e, cupom, etc.)
      - Número do documento fiscal

      Considere descontos, promoções e formas de pagamento. Se houver desconto, calcule o valor original e o desconto aplicado.

      Texto: "${text}"

      Responda APENAS em JSON no seguinte formato:
      {
        "amount": 0.00,
        "original_amount": 0.00,
        "discount_amount": 0.00,
        "category": "Categoria",
        "date": "YYYY-MM-DD",
        "description": "Descrição do gasto",
        "payment_method": "Forma de pagamento",
        "store_name": "Nome da loja",
        "store_cnpj": "CNPJ da loja",
        "store_address": "Endereço da loja",
        "document_type": "Tipo de documento",
        "document_number": "Número do documento"
      }
    `;

    try {
      // Tentar primeiro com GPT-4
      this.logger.log('🤖 Processando com GPT-4...');
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Você é um assistente que extrai dados financeiros de textos. Responda apenas em JSON válido.'
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
          const data = JSON.parse(jsonMatch[0]);
          this.logger.log('✅ Dados extraídos com GPT-4');
          
          // Adicionar campos obrigatórios com valores padrão
          return {
            ...data,
            document_classification: 'expense', // Será sobrescrito pelos métodos específicos
            expense_type: 'purchase',
          };
        }
      }
    } catch (error) {
      this.logger.warn('⚠️ Falha com GPT-4, tentando Gemini:', error);
    }

    try {
      // Fallback para Gemini
      this.logger.log('🤖 Processando com Gemini...');
      const result = await this.gemini.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const response = await result.generateContent(prompt);
      const responseText = response.response.text();
      
      // Extrair JSON da resposta
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        this.logger.log('✅ Dados extraídos com Gemini');
        
        // Adicionar campos obrigatórios com valores padrão
        return {
          ...data,
          document_classification: 'expense', // Será sobrescrito pelos métodos específicos
          expense_type: 'purchase',
        };
      }
    } catch (error) {
      this.logger.error('❌ Falha com Gemini:', error);
    }

    // Fallback manual se ambas as IAs falharem
    this.logger.warn('⚠️ Usando extração manual');
    return this.extractDataManually(text);
  }

  private extractDataManually(text: string): ExtractedData {
    // Extração manual básica
    const amountMatch = text.match(/R?\$?\s*(\d+[.,]\d{2}|\d+)/);
    const amount = amountMatch ? parseFloat(amountMatch[1].replace(',', '.')) : 0;

    // Tentar extrair valor original e desconto
    let originalAmount = amount;
    let discountAmount = 0;
    
    const originalMatch = text.match(/R?\$?\s*(\d+[.,]\d{2}|\d+)\s*por\s*R?\$?\s*(\d+[.,]\d{2}|\d+)/);
    if (originalMatch) {
      originalAmount = parseFloat(originalMatch[1].replace(',', '.'));
      const finalAmount = parseFloat(originalMatch[2].replace(',', '.'));
      discountAmount = originalAmount - finalAmount;
    }

    const currentDate = this.getCurrentDateInSaoPaulo();

    // Tentar extrair categoria baseada no texto
    let category = 'Outros';
    const lowerText = text.toLowerCase();
    
    if (lowerText.includes('supermercado') || lowerText.includes('mercado') || lowerText.includes('alimento')) {
      category = 'Alimentação';
    } else if (lowerText.includes('uber') || lowerText.includes('taxi') || lowerText.includes('transporte')) {
      category = 'Transporte';
    } else if (lowerText.includes('farmacia') || lowerText.includes('medicamento') || lowerText.includes('saude') || lowerText.includes('drogaria')) {
      category = 'Saúde';
    } else if (lowerText.includes('cinema') || lowerText.includes('restaurante') || lowerText.includes('lazer')) {
      category = 'Lazer';
    } else if (lowerText.includes('escola') || lowerText.includes('curso') || lowerText.includes('educacao')) {
      category = 'Educação';
    } else if (lowerText.includes('aluguel') || lowerText.includes('condominio') || lowerText.includes('moradia')) {
      category = 'Moradia';
    }

    // Tentar extrair forma de pagamento
    let paymentMethod = '';
    if (lowerText.includes('pix')) {
      paymentMethod = 'PIX';
    } else if (lowerText.includes('cartao') || lowerText.includes('card')) {
      paymentMethod = 'Cartão';
    } else if (lowerText.includes('dinheiro') || lowerText.includes('cash')) {
      paymentMethod = 'Dinheiro';
    }

    // Tentar extrair nome da loja
    let storeName = '';
    const storeMatch = text.match(/([A-Z][A-Z\s]+(?:LTDA|ME|EPP|SA|S\.A\.))/);
    if (storeMatch) {
      storeName = storeMatch[1].trim();
    }

    return {
      amount,
      original_amount: originalAmount,
      discount_amount: discountAmount,
      category,
      date: currentDate,
      description: text.substring(0, 100) || 'Despesa não identificada',
      payment_method: paymentMethod,
      store_name: storeName,
      document_classification: 'expense', // Default para despesa
      expense_type: 'purchase',
    };
  }

  async generateResponse(message: string, userData?: any): Promise<string> {
    const prompt = `
      Você é o MePoupeBot, um assistente financeiro pessoal amigável via WhatsApp! 🤖💰
      
      Responda de forma natural, sem formalidade excessiva, como se fosse um amigo conversando.
      Use emojis ocasionalmente para tornar a conversa mais amigável e envolvente.
      
      FUNCIONALIDADES DISPONÍVEIS:
      
      📸 REGISTRAR DESPESAS/RECEITAS:
      - Envie fotos de comprovantes, recibos, notas fiscais
      - Envie áudios descrevendo suas despesas ou receitas
      - Digite mensagens como "Compra no mercado R$ 150" ou "Salário R$ 3000"
      
      📊 RELATÓRIOS E CONSULTAS:
      - "hoje" ou "gastos de hoje" - Ver despesas de hoje
      - "ontem" ou "gastos de ontem" - Ver despesas de ontem
      - "semana" ou "gastos da semana" - Relatório semanal
      - "mês" ou "gastos do mês" - Relatório mensal
      - "22/07/2025" - Data específica
      - "receitas" - Ver suas receitas
      - "balanço" - Resumo geral
      
      💡 DICAS E AJUDA:
      - "dicas" - Dicas de economia
      - "como economizar" - Sugestões práticas
      - "orçamento" - Ajuda com planejamento
      
      🚀 UPGRADE E PLANOS:
      - "upgrade" ou "planos" - Conhecer planos premium
      - "limites" - Ver seus limites atuais
      
      O contexto da conversa deve ser sempre sobre controle de gastos pessoal, economizar e planejar melhor suas finanças.
      Se o usuário sair do contexto, redirecione gentilmente para as funcionalidades financeiras.
      
      IMPORTANTE: Sempre seja útil e amigável, sempre em português brasileiro.
      
      Mensagem do usuário: "${message}"
      
      Responda de forma natural e amigável, e SEMPRE termine sua resposta com:
      
      "💡 Dica: Digite 'menu' para ver todas as funcionalidades disponíveis!"
    `;

    try {
      // Tentar primeiro com GPT-4
      this.logger.log('🤖 Gerando resposta com GPT-4...');
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Você é o MePoupeBot, um assistente financeiro pessoal amigável via WhatsApp. Seja natural, use emojis ocasionalmente e sempre termine suas respostas sugerindo o usuário digitar "menu" para ver todas as funcionalidades.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
      });

      const response = completion.choices[0]?.message?.content;
      if (response) {
        this.logger.log('✅ Resposta gerada com GPT-4');
        return response;
      }
    } catch (error) {
      this.logger.warn('⚠️ Falha com GPT-4, tentando Gemini:', error);
    }

    try {
      // Fallback para Gemini
      this.logger.log('🤖 Gerando resposta com Gemini...');
      const result = await this.gemini.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const response = await result.generateContent(prompt);
      const responseText = response.response.text();
      
      this.logger.log('✅ Resposta gerada com Gemini');
      return responseText;
    } catch (error) {
      this.logger.error('❌ Falha com Gemini:', error);
    }

    // Resposta padrão se ambas as IAs falharem
    return 'Desculpe, não consegui processar sua mensagem. Pode tentar novamente? 😊';
  }

  async generateExpenseReportResponse(reportData: any, userMessage: string): Promise<string> {
    const prompt = `
      Você é um assistente financeiro amigável. Gere um relatório de despesas baseado nos dados fornecidos.
      
      Dados do relatório:
      - Período: ${reportData.period}
      - Total gasto: R$ ${reportData.total.toFixed(2)}
      - Total de descontos: R$ ${reportData.totalDiscounts.toFixed(2)}
      - Quantidade de despesas: ${reportData.count}
      
      Categorias:
      ${Object.entries(reportData.byCategory).map(([category, data]: [string, any]) => 
        `- ${category}: R$ ${data.total.toFixed(2)} (${data.count} despesas)`
      ).join('\n')}
      
      Formas de pagamento:
      ${Object.entries(reportData.byPaymentMethod).map(([method, amount]: [string, number]) => 
        `- ${method}: R$ ${amount.toFixed(2)}`
      ).join('\n')}
      
      Top 5 despesas mais caras:
      ${reportData.topExpenses.map((expense: any, index: number) => 
        `${index + 1}. ${expense.description}: R$ ${expense.amount.toFixed(2)}`
      ).join('\n')}
      
      Mensagem original do usuário: "${userMessage}"
      
      Gere um relatório amigável e natural, sem formalidade excessiva. Use emojis ocasionalmente.
      Seja específico sobre os dados mais relevantes e dê insights úteis.
      Se não houver despesas, seja encorajador.
    `;

    try {
      this.logger.log('📊 Gerando relatório com GPT-4...');
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Você é um assistente financeiro amigável. Gere relatórios naturais e úteis.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
      });

      const response = completion.choices[0]?.message?.content;
      if (response) {
        this.logger.log('✅ Relatório gerado com GPT-4');
        return response;
      }
    } catch (error) {
      this.logger.warn('⚠️ Falha com GPT-4, usando relatório padrão:', error);
    }

    // Relatório padrão se a IA falhar
    return this.generateDefaultReport(reportData);
  }

  private generateDefaultReport(reportData: any): string {
    if (reportData.count === 0) {
      return `📊 Relatório de ${reportData.period}:\n\nNenhuma despesa registrada! 🎉\n\nContinue assim, você está economizando! 💪`;
    }

    let report = `📊 Relatório de ${reportData.period}:\n\n`;
    report += `💰 Total gasto: R$ ${reportData.total.toFixed(2)}\n`;
    report += `📝 ${reportData.count} despesas registradas\n`;
    
    if (reportData.totalDiscounts > 0) {
      report += `🎯 Total de descontos: R$ ${reportData.totalDiscounts.toFixed(2)}\n`;
    }
    
    report += `\n📂 Por categoria:\n`;
    Object.entries(reportData.byCategory).forEach(([category, data]: [string, any]) => {
      report += `• ${category}: R$ ${data.total.toFixed(2)} (${data.count} despesas)\n`;
    });
    
    if (reportData.topExpenses.length > 0) {
      report += `\n🔥 Maior despesa: ${reportData.topExpenses[0].description} - R$ ${reportData.topExpenses[0].amount.toFixed(2)}\n`;
    }
    
    return report;
  }

  async generateFinancialReportResponse(reportData: any, userMessage: string): Promise<string> {
    try {
      const prompt = `
        Analise os dados financeiros fornecidos e gere um relatório completo e humanizado em português brasileiro.

        Dados do relatório:
        ${JSON.stringify(reportData, null, 2)}

        Mensagem do usuário: "${userMessage}"

        Gere um relatório que inclua:
        1. **Resumo Executivo** - Visão geral dos resultados
        2. **Receitas** - Total, categorias principais, tendências
        3. **Despesas** - Total, categorias principais, alertas
        4. **Resultado Líquido** - Saldo (receitas - despesas)
        5. **Análise de Categorias** - Principais fontes de receita e gastos
        6. **Insights e Recomendações** - Dicas práticas baseadas nos dados
        7. **Comparações** - Se houver dados de períodos anteriores

        Use emojis apropriados, seja motivacional e ofereça insights úteis.
        Se o resultado for negativo, seja encorajador e sugira melhorias.
        Se for positivo, parabenize e sugira como manter o sucesso.

        Formato: Markdown com seções bem definidas.
        Tom: Amigável, profissional e motivacional.
      `;

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Você é um assistente financeiro especializado em análise de dados pessoais. Seja preciso, motivacional e ofereça insights práticos.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
      });

      const response = completion.choices[0]?.message?.content;
      if (response) {
        this.logger.log('✅ Relatório financeiro gerado com sucesso');
        return response;
      }

      return this.generateDefaultFinancialReport(reportData);
    } catch (error) {
      this.logger.error('❌ Erro ao gerar relatório financeiro:', error);
      return this.generateDefaultFinancialReport(reportData);
    }
  }

  private generateDefaultFinancialReport(reportData: any): string {
    const { total_revenue, total_expenses, net_income, revenue_by_category, expense_by_category, period } = reportData;
    
    const revenueTotal = new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(total_revenue);

    const expenseTotal = new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(total_expenses);

    const netIncome = new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(net_income);

    let report = `📊 **RELATÓRIO FINANCEIRO - ${period.toUpperCase()}**\n\n`;
    
    // Resumo Executivo
    report += `🎯 **RESUMO EXECUTIVO**\n`;
    report += `💰 **Receitas:** ${revenueTotal}\n`;
    report += `💸 **Despesas:** ${expenseTotal}\n`;
    report += `📈 **Resultado:** ${netIncome}\n\n`;

    // Análise de Receitas
    if (revenue_by_category && Object.keys(revenue_by_category).length > 0) {
      report += `💡 **PRINCIPAIS RECEITAS**\n`;
      Object.entries(revenue_by_category)
        .sort(([,a], [,b]) => (b as number) - (a as number))
        .slice(0, 3)
        .forEach(([category, amount]) => {
          const formattedAmount = new Intl.NumberFormat('pt-BR', {
            style: 'currency',
            currency: 'BRL'
          }).format(amount as number);
          report += `• ${category}: ${formattedAmount}\n`;
        });
      report += '\n';
    }

    // Análise de Despesas
    if (expense_by_category && Object.keys(expense_by_category).length > 0) {
      report += `⚠️ **PRINCIPAIS DESPESAS**\n`;
      Object.entries(expense_by_category)
        .sort(([,a], [,b]) => (b as number) - (a as number))
        .slice(0, 3)
        .forEach(([category, amount]) => {
          const formattedAmount = new Intl.NumberFormat('pt-BR', {
            style: 'currency',
            currency: 'BRL'
          }).format(amount as number);
          report += `• ${category}: ${formattedAmount}\n`;
        });
      report += '\n';
    }

    // Insights
    report += `💭 **INSIGHTS**\n`;
    if (net_income > 0) {
      report += `✅ Excelente! Você está com saldo positivo de ${netIncome}.\n`;
      report += `🎯 Continue mantendo o controle e considere investir o excedente.\n`;
    } else if (net_income < 0) {
      report += `⚠️ Atenção! Você está com saldo negativo de ${netIncome}.\n`;
      report += `🔍 Analise suas despesas e identifique oportunidades de economia.\n`;
    } else {
      report += `⚖️ Seu saldo está equilibrado. Continue monitorando suas finanças.\n`;
    }

    report += `\n📱 **Para mais detalhes, envie imagens de seus comprovantes!**`;

    return report;
  }

  private async extractRevenueData(imageBuffer: Buffer, classification: DocumentClassification): Promise<ExtractedData> {
    try {
      // Tentar primeiro com OpenAI Vision API
      this.logger.log('🤖 Extraindo dados de receita com OpenAI Vision API...');
      const data = await this.extractDataWithOpenAIVision(imageBuffer);
      
      // Adicionar campos específicos de receita
      return {
        ...data,
        document_classification: 'revenue',
        revenue_type: classification.documentCategory,
        payer_name: data.store_name, // Mapear store_name para payer_name
        payer_cnpj: data.store_cnpj, // Mapear store_cnpj para payer_cnpj
        payer_address: data.store_address, // Mapear store_address para payer_address
        source: this.mapRevenueCategoryToSource(classification.documentCategory),
      };
    } catch (visionError) {
      this.logger.warn('⚠️ Falha com OpenAI Vision, tentando Tesseract:', visionError);
      
      try {
        const data = await this.extractDataWithTesseract(imageBuffer);
        return {
          ...data,
          document_classification: 'revenue',
          revenue_type: classification.documentCategory,
          payer_name: data.store_name,
          payer_cnpj: data.store_cnpj,
          payer_address: data.store_address,
          source: this.mapRevenueCategoryToSource(classification.documentCategory),
        };
      } catch (tesseractError) {
        this.logger.error('❌ Falha com Tesseract:', tesseractError);
        
        // Fallback manual
        const manualData = this.extractDataManually('Imagem não pôde ser processada');
        return {
          ...manualData,
          document_classification: 'revenue',
          revenue_type: classification.documentCategory,
          source: this.mapRevenueCategoryToSource(classification.documentCategory),
        };
      }
    }
  }

  private async extractExpenseData(imageBuffer: Buffer, classification: DocumentClassification): Promise<ExtractedData> {
    try {
      // Tentar primeiro com OpenAI Vision API
      this.logger.log('🤖 Extraindo dados de despesa com OpenAI Vision API...');
      const data = await this.extractDataWithOpenAIVision(imageBuffer);
      
      // Adicionar campos específicos de despesa
      return {
        ...data,
        document_classification: 'expense',
        expense_type: classification.documentCategory,
      };
    } catch (visionError) {
      this.logger.warn('⚠️ Falha com OpenAI Vision, tentando Tesseract:', visionError);
      
      try {
        const data = await this.extractDataWithTesseract(imageBuffer);
        return {
          ...data,
          document_classification: 'expense',
          expense_type: classification.documentCategory,
        };
      } catch (tesseractError) {
        this.logger.error('❌ Falha com Tesseract:', tesseractError);
        
        // Fallback manual
        const manualData = this.extractDataManually('Imagem não pôde ser processada');
        return {
          ...manualData,
          document_classification: 'expense',
          expense_type: classification.documentCategory,
        };
      }
    }
  }

  private mapRevenueCategoryToSource(category: string): string {
    const sourceMap: Record<string, string> = {
      'salary': 'employer',
      'freelance': 'client',
      'sale': 'customer',
      'investment': 'financial_institution',
      'refund': 'original_payer',
      'transfer': 'sender',
      'rent': 'tenant',
      'commission': 'employer',
      'other': 'unknown'
    };
    
    return sourceMap[category] || 'unknown';
  }

  private async convertImageToJPEG(imageBuffer: Buffer): Promise<Buffer> {
    try {
      this.logger.log('🔄 Convertendo imagem para JPEG...');
      
      // Tentar converter usando Sharp
      const convertedBuffer = await sharp(imageBuffer)
        .jpeg({ quality: 90 })
        .toBuffer();
      
      this.logger.log('✅ Conversão concluída, novo tamanho:', convertedBuffer.length, 'bytes');
      return convertedBuffer;
    } catch (error) {
      this.logger.error('❌ Erro na conversão:', error);
      throw error;
    }
  }

  async generateUpgradeResponse(userMessage: string, state: any): Promise<string> {
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
    
    return this.generateResponse(userMessage);
  }

  // NOVOS MÉTODOS PARA DETECÇÃO DE LANÇAMENTOS
  async detectReportIntent(text: string): Promise<{
    isReportRequest: boolean;
    confidence: number;
    intent: string;
  }> {
    try {
      this.logger.log('📊 Detectando intent de relatório:', text);

      const prompt = `Analise a seguinte mensagem e determine se o usuário está solicitando um relatório financeiro ou informações sobre seus gastos/receitas.

Mensagem: "${text}"

Responda apenas com um JSON no seguinte formato:
{
  "isReportRequest": true/false,
  "confidence": 0.0-1.0,
  "intent": "descrição da intenção"
}

Critérios para considerar como solicitação de relatório:
- Palavras como: relatório, resumo, gastos, despesas, receitas, quanto gastei, quanto ganhei
- Perguntas sobre períodos: hoje, ontem, semana, mês, ano
- Solicitações de análise: análise, gráfico, estatísticas, balanço
- Palavras relacionadas a dashboard: dashboard, painel, controle, acompanhamento
- Perguntas sobre status financeiro: status, situação, posição

Exemplos que DEVEM ser detectados:
- "Quanto gastei hoje?"
- "Me mostra um relatório"
- "Quais foram minhas despesas do mês?"
- "Preciso ver meus gastos"
- "Como está minha situação financeira?"
- "Me mostra um resumo"
- "Quero ver meus dados"

Exemplos que NÃO devem ser detectados:
- "Gastei 50 reais no mercado"
- "Recebi meu salário"
- "Quero fazer upgrade"
- "Como funciona o bot?"`;

      // Usar GPT-4o (mais econômico que GPT-4) com temperatura baixa para consistência
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Você é um detector especializado em identificar solicitações de relatórios financeiros. Seja preciso e consistente.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1, // Baixa temperatura para consistência
      });

      const responseText = completion.choices[0]?.message?.content;
      if (responseText) {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsedResponse = JSON.parse(jsonMatch[0]);
          
          this.logger.log('📊 Intent de relatório detectado:', parsedResponse);
          
          return {
            isReportRequest: parsedResponse.isReportRequest || false,
            confidence: parsedResponse.confidence || 0,
            intent: parsedResponse.intent || 'não especificado'
          };
        }
      }

      this.logger.warn('⚠️ Resposta da IA não contém JSON válido:', responseText);
      return {
        isReportRequest: false,
        confidence: 0,
        intent: 'resposta inválida'
      };

    } catch (error) {
      this.logger.error('❌ Erro ao detectar intent de relatório:', error);
      
      // Fallback: detecção manual simples
      return this.detectReportIntentManually(text);
    }
  }

  async detectFinancialEntry(text: string): Promise<{
    isFinancialEntry: boolean;
    type: 'revenue' | 'expense' | null;
    confidence: number;
    reason: string;
  }> {
    try {
      const prompt = `
        Analise a mensagem abaixo e determine se representa um lançamento financeiro (receita ou despesa).

        REGRAS PARA IDENTIFICAR LANÇAMENTOS:
        1. **Formatos aceitos**:
           - "Descrição Valor" (ex: "Aluguel 2000")
           - "Valor Descrição" (ex: "2000 Aluguel")
           - "Descrição Valor Data" (ex: "Recebimento de bônus 980 no dia 19/07")
           - "Descrição Valor em Data" (ex: "Salário 5000 em 15/07")
           - "Descrição Valor dia Data" (ex: "Venda 300 dia 20/07")
           - "Descrição Valor na Data" (ex: "Uber 25 na sexta")
        
        2. **Exemplos de DESPESAS**:
           - "Aluguel 2000" → Despesa de R$ 2000
           - "Supermercado 150" → Despesa de R$ 150
           - "Uber 25" → Despesa de R$ 25
           - "Conta de luz 120" → Despesa de R$ 120
           - "Aluguel 2000 no dia 05/07" → Despesa de R$ 2000
        
        3. **Exemplos de RECEITAS**:
           - "Salário 5000" → Receita de R$ 5000
           - "Freelance 800" → Receita de R$ 800
           - "Venda 300" → Receita de R$ 300
           - "Reembolso 50" → Receita de R$ 50
           - "Recebimento de bônus 980 no dia 19/07" → Receita de R$ 980
           - "Bônus 500 em 15/07" → Receita de R$ 500
           - "Pix recebido 1000" → Receita de R$ 1000
           - "Recebimento de serviço 1000" → Receita de R$ 1000
        
        4. **Exemplos de CONVERSA (não é lançamento)**:
           - "Oi, tudo bem?"
           - "Como faço para ver meus gastos?"
           - "Quero um relatório"
           - "Obrigado"
           - "Tchau"
           - "Relatório de hoje"
           - "Mostre meus gastos"

        IMPORTANTE: Se a mensagem contém um valor monetário E uma descrição de transação (mesmo com data), é um lançamento financeiro.

        MENSAGEM PARA ANALISAR: "${text}"

        Responda APENAS em JSON:
        {
          "isFinancialEntry": true/false,
          "type": "revenue"/"expense"/null,
          "confidence": 0.95,
          "reason": "Explicação detalhada"
        }
      `;

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Você é um detector especializado em identificar lançamentos financeiros. Seja preciso mas não muito restritivo. Se há valor monetário e descrição de transação, é um lançamento.'
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
          this.logger.log('✅ Detecção de lançamento:', result);
          return result;
        }
      }

      // Fallback para detecção manual
      return this.detectFinancialEntryManually(text);
    } catch (error) {
      this.logger.error('❌ Erro na detecção de lançamento:', error);
      return this.detectFinancialEntryManually(text);
    }
  }

  private detectReportIntentManually(text: string): {
    isReportRequest: boolean;
    confidence: number;
    intent: string;
  } {
    const lowerText = text.toLowerCase();
    
    // Palavras-chave que indicam solicitação de relatório
    const reportKeywords = [
      'relatório', 'resumo', 'gastos', 'despesas', 'receitas', 
      'quanto gastei', 'quanto ganhei', 'análise', 'gráfico', 
      'estatísticas', 'balanço', 'dashboard', 'painel', 'controle',
      'acompanhamento', 'status', 'situação', 'posição', 'dados',
      'informações', 'mostra', 'ver', 'visualizar', 'consultar'
    ];
    
    // Períodos que indicam solicitação de relatório
    const periodKeywords = [
      'hoje', 'ontem', 'semana', 'mês', 'mes', 'ano', 'período',
      'último', 'passado', 'atual', 'recente'
    ];
    
    // Verificar se contém palavras-chave de relatório
    const hasReportKeywords = reportKeywords.some(keyword => lowerText.includes(keyword));
    const hasPeriodKeywords = periodKeywords.some(keyword => lowerText.includes(keyword));
    
    // Verificar se é uma pergunta
    const isQuestion = lowerText.includes('?') || 
                      lowerText.includes('quanto') || 
                      lowerText.includes('quais') || 
                      lowerText.includes('como') ||
                      lowerText.includes('me mostra') ||
                      lowerText.includes('preciso ver') ||
                      lowerText.includes('quero ver');
    
    // Calcular confiança baseada nos critérios
    let confidence = 0;
    let intent = '';
    
    if (hasReportKeywords && isQuestion) {
      confidence = 0.9;
      intent = 'solicitação de relatório com período específico';
    } else if (hasReportKeywords) {
      confidence = 0.7;
      intent = 'solicitação de relatório';
    } else if (hasPeriodKeywords && isQuestion) {
      confidence = 0.6;
      intent = 'consulta por período';
    } else if (isQuestion && (lowerText.includes('gasto') || lowerText.includes('despesa') || lowerText.includes('receita'))) {
      confidence = 0.5;
      intent = 'consulta financeira';
    }
    
    return {
      isReportRequest: confidence > 0.4,
      confidence,
      intent
    };
  }

  private detectFinancialEntryManually(text: string): {
    isFinancialEntry: boolean;
    type: 'revenue' | 'expense' | null;
    confidence: number;
    reason: string;
  } {
    const lowerText = text.toLowerCase().trim();
    
    // Padrões para detectar valores monetários (mais flexível)
    const moneyPattern = /(?:r?\$?\s*)?(\d+[.,]\d{2}|\d+)/i;
    const hasMoney = moneyPattern.test(text);
    
    if (!hasMoney) {
      return {
        isFinancialEntry: false,
        type: null,
        confidence: 0.9,
        reason: 'Não contém valor monetário'
      };
    }

    // Palavras-chave para receitas (expandidas)
    const revenueKeywords = [
      'salário', 'salary', 'pagamento', 'payment', 'recebido', 'received',
      'freelance', 'freela', 'venda', 'sale', 'vendi', 'sold',
      'investimento', 'investment', 'rendimento', 'dividendo',
      'reembolso', 'refund', 'estorno', 'chargeback',
      'transferência', 'transfer', 'pix recebido', 'pix received',
      'aluguel recebido', 'rent received', 'comissão', 'commission',
      'bônus', 'bonus', 'prêmio', 'award', 'recebimento'
    ];

    // Palavras-chave para despesas (expandidas)
    const expenseKeywords = [
      'aluguel', 'rent', 'supermercado', 'supermarket', 'mercado', 'market',
      'uber', 'taxi', 'transporte', 'transport', 'combustível', 'fuel',
      'gasolina', 'gas', 'energia', 'energy', 'luz', 'light',
      'água', 'water', 'internet', 'telefone', 'phone',
      'restaurante', 'restaurant', 'lanche', 'lunch', 'jantar', 'dinner',
      'farmácia', 'pharmacy', 'medicamento', 'medicine', 'saúde', 'health',
      'cinema', 'teatro', 'show', 'lazer', 'entertainment',
      'escola', 'school', 'curso', 'course', 'educação', 'education',
      'roupa', 'clothes', 'sapato', 'shoes', 'acessório', 'accessory',
      'conta', 'bill', 'boleto', 'invoice', 'fatura', 'statement',
      'gasto', 'despesa', 'pagamento', 'payment'
    ];

    // Palavras que indicam que NÃO é um lançamento
    const nonFinancialKeywords = [
      'relatório', 'report', 'mostre', 'show', 'ver', 'see', 'quero', 'want',
      'como', 'how', 'ajuda', 'help', 'oi', 'hello', 'olá', 'hi',
      'obrigado', 'thanks', 'tchau', 'bye', 'tudo bem', 'ok', 'okay'
    ];

    // Verificar se contém palavras que indicam que NÃO é lançamento
    const isNonFinancial = nonFinancialKeywords.some(keyword => lowerText.includes(keyword));
    if (isNonFinancial) {
      return {
        isFinancialEntry: false,
        type: null,
        confidence: 0.8,
        reason: 'Contém palavras que indicam conversa, não lançamento'
      };
    }

    const isRevenue = revenueKeywords.some(keyword => lowerText.includes(keyword));
    const isExpense = expenseKeywords.some(keyword => lowerText.includes(keyword));

    // Se tem dinheiro e palavras-chave de receita
    if (isRevenue && !isExpense) {
      return {
        isFinancialEntry: true,
        type: 'revenue',
        confidence: 0.9,
        reason: 'Contém valor monetário e palavras-chave de receita'
      };
    }

    // Se tem dinheiro e palavras-chave de despesa
    if (isExpense && !isRevenue) {
      return {
        isFinancialEntry: true,
        type: 'expense',
        confidence: 0.9,
        reason: 'Contém valor monetário e palavras-chave de despesa'
      };
    }

    // Se tem dinheiro mas não tem palavras-chave claras, analisar contexto
    if (hasMoney) {
      // Verificar se parece ser uma descrição de transação
      const hasTransactionWords = lowerText.includes('no dia') || 
                                 lowerText.includes('em ') || 
                                 lowerText.includes('dia ') ||
                                 lowerText.includes('na ') ||
                                 lowerText.includes('recebimento') ||
                                 lowerText.includes('pagamento') ||
                                 lowerText.includes('gasto') ||
                                 lowerText.includes('despesa');

      if (hasTransactionWords) {
        // Se tem palavras de receita, é receita
        if (isRevenue) {
          return {
            isFinancialEntry: true,
            type: 'revenue',
            confidence: 0.8,
            reason: 'Contém valor monetário e contexto de receita'
          };
        }
        // Se tem palavras de despesa, é despesa
        if (isExpense) {
          return {
            isFinancialEntry: true,
            type: 'expense',
            confidence: 0.8,
            reason: 'Contém valor monetário e contexto de despesa'
          };
        }
        // Se não tem palavras específicas, assumir como despesa (mais comum)
        return {
          isFinancialEntry: true,
          type: 'expense',
          confidence: 0.7,
          reason: 'Contém valor monetário e contexto de transação, assumindo como despesa'
        };
      }
    }

    return {
      isFinancialEntry: false,
      type: null,
      confidence: 0.9,
      reason: 'Não parece ser um lançamento financeiro'
    };
  }

  async extractDataFromText(text: string): Promise<ExtractedData> {
    try {
      this.logger.log('📝 Extraindo dados do texto:', text);

      // Usar função unificada para extração de informações financeiras
      const financialInfo = await this.extractFinancialInfoWithAI(text);
      
      // Criar dados estruturados
      const extractedData: ExtractedData = {
        amount: financialInfo.amount,
        category: this.mapCategoryFromDescription(financialInfo.description, financialInfo.type),
        date: financialInfo.date || this.getCurrentDateInSaoPaulo(),
        description: financialInfo.description,
        payment_method: financialInfo.payment_method,
        document_classification: financialInfo.type,
        // Campos específicos baseados no tipo
        ...(financialInfo.type === 'revenue' ? {
          revenue_type: this.mapRevenueTypeFromDescription(financialInfo.description),
          source: financialInfo.description
        } : {
          expense_type: this.mapExpenseTypeFromDescription(financialInfo.description),
          store_name: financialInfo.description
        })
      };
      
      this.logger.log('✅ Dados extraídos do texto:', extractedData);
      return extractedData;

    } catch (error) {
      this.logger.error('❌ Erro ao extrair dados do texto:', error);
      throw error;
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
   * Processa áudio para lançamento financeiro com normalização melhorada
   */
  async processAudioForFinancialEntry(audioBuffer: Buffer): Promise<ExtractedData> {
    try {
      this.logger.log('🎵 Processando áudio para lançamento financeiro...');

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
      
      this.logger.log('🎵 Transcrição original:', transcribedText);
      
      // 3. Extrair informações financeiras usando IA
      const financialInfo = await this.extractFinancialInfoWithAI(transcribedText);
      
      // 4. Criar dados estruturados
      const extractedData: ExtractedData = {
        amount: financialInfo.amount,
        category: this.mapCategoryFromDescription(financialInfo.description, financialInfo.type),
        date: financialInfo.date || this.getCurrentDateInSaoPaulo(), // Usar data da IA ou atual
        description: financialInfo.description,
        payment_method: financialInfo.payment_method,
        document_classification: financialInfo.type,
        // Campos específicos baseados no tipo
        ...(financialInfo.type === 'revenue' ? {
          revenue_type: this.mapRevenueTypeFromDescription(financialInfo.description),
          source: financialInfo.description
        } : {
          expense_type: this.mapExpenseTypeFromDescription(financialInfo.description),
          store_name: financialInfo.description
        })
      };
      
      this.logger.log('✅ Dados extraídos do áudio:', extractedData);
      return extractedData;

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

  async analyzeUpgradeIntent(text: string, context: any): Promise<{
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

  async detectNewUpgradeIntent(text: string): Promise<{
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

  async detectFrequencySelection(text: string): Promise<{
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

  /**
   * Normaliza a transcrição de áudio para facilitar o processamento
   */
  private normalizeAudioTranscription(transcription: string): string {
    try {
      this.logger.log('🧹 Normalizando transcrição:', transcription);
      
      let normalized = transcription.trim();
      
      // Remover pontuação desnecessária
      normalized = normalized.replace(/[.,;:!?]/g, ' ');
      
      // Normalizar espaços múltiplos
      normalized = normalized.replace(/\s+/g, ' ');
      
      // Converter para minúsculas
      normalized = normalized.toLowerCase();
      
      // Normalizar formatos de valor monetário (preservar estrutura)
      normalized = normalized.replace(/r\$\s*(\d+[.,]?\d*)/gi, '$1');
      normalized = normalized.replace(/(\d+)\s*reais?/gi, '$1');
      normalized = normalized.replace(/(\d+)\s*real/gi, '$1');
      
      // Normalizar vírgulas em números para pontos (apenas para valores monetários)
      normalized = normalized.replace(/(\d+),(\d{2})/g, '$1.$2');
      
      // Preservar valores como "350 00" para que a IA possa interpretar
      // Não fazer normalização excessiva que quebre a estrutura
      
      this.logger.log('✅ Transcrição normalizada:', normalized);
      return normalized;
    } catch (error) {
      this.logger.error('❌ Erro ao normalizar transcrição:', error);
      return transcription;
    }
  }



  /**
   * Mapeia categoria baseada na descrição e tipo
   */
  private mapCategoryFromDescription(description: string, type: 'revenue' | 'expense'): string {
    const lowerDesc = description.toLowerCase();
    
    if (type === 'revenue') {
      if (lowerDesc.includes('salário') || lowerDesc.includes('salario')) return 'Salário';
      if (lowerDesc.includes('freelance')) return 'Freelance';
      if (lowerDesc.includes('venda')) return 'Venda';
      if (lowerDesc.includes('reembolso')) return 'Reembolso';
      if (lowerDesc.includes('bônus') || lowerDesc.includes('bonus')) return 'Bônus';
      if (lowerDesc.includes('investimento')) return 'Investimento';
      return 'Outros';
    } else {
      if (lowerDesc.includes('aluguel')) return 'Moradia';
      if (lowerDesc.includes('supermercado') || lowerDesc.includes('compra')) return 'Alimentação';
      if (lowerDesc.includes('uber') || lowerDesc.includes('99') || lowerDesc.includes('taxi')) return 'Transporte';
      if (lowerDesc.includes('luz') || lowerDesc.includes('água') || lowerDesc.includes('agua') || lowerDesc.includes('internet')) return 'Contas';
      if (lowerDesc.includes('farmácia') || lowerDesc.includes('farmacia')) return 'Saúde';
      if (lowerDesc.includes('restaurante') || lowerDesc.includes('lanche')) return 'Alimentação';
      return 'Outros';
    }
  }

  /**
   * Mapeia tipo de receita baseado na descrição
   */
  private mapRevenueTypeFromDescription(description: string): string {
    const lowerDesc = description.toLowerCase();
    
    if (lowerDesc.includes('salário') || lowerDesc.includes('salario')) return 'salary';
    if (lowerDesc.includes('freelance')) return 'freelance';
    if (lowerDesc.includes('venda')) return 'sale';
    if (lowerDesc.includes('investimento')) return 'investment';
    if (lowerDesc.includes('reembolso')) return 'refund';
    return 'other';
  }

  /**
   * Mapeia tipo de despesa baseado na descrição
   */
  private mapExpenseTypeFromDescription(description: string): string {
    const lowerDesc = description.toLowerCase();
    
    if (lowerDesc.includes('compra') || lowerDesc.includes('supermercado')) return 'purchase';
    if (lowerDesc.includes('aluguel') || lowerDesc.includes('conta')) return 'bill';
    if (lowerDesc.includes('uber') || lowerDesc.includes('99') || lowerDesc.includes('taxi')) return 'service';
    return 'other';
  }

  /**
   * Extrai informações financeiras da transcrição usando IA (unificado para áudio e texto)
   */
  private async extractFinancialInfoWithAI(transcription: string): Promise<{
    description: string;
    amount: number;
    payment_method?: string;
    type: 'revenue' | 'expense';
    confidence: number;
    date?: string;
  }> {
    try {
      this.logger.log('🧠 Extraindo informações financeiras com IA:', transcription);
      
      // Obter data atual em São Paulo
      const currentDate = new Date();
      const currentDay = currentDate.getDate();
      const currentMonth = currentDate.getMonth() + 1; // getMonth() retorna 0-11
      const currentYear = currentDate.getFullYear();
      this.logger.log('🔍 Data atual:', currentDay, currentMonth, currentYear);
      
      const prompt = `Analise a seguinte transcrição e extraia informações financeiras.

Transcrição: "${transcription}"

Data atual (São Paulo): ${currentDay}/${currentMonth}/${currentYear}

Instruções:
1. Identifique o valor monetário (qualquer formato: R$ 350,00, 350 reais, 350 00, trezentos e cinquenta, etc.)
2. Identifique a descrição da transação
3. Identifique o método de pagamento (se mencionado)
4. Classifique como receita ou despesa baseado no contexto
5. Identifique a data da transação (se mencionada)

IMPORTANTE: Para valores monetários:
- "R$ 350,00" → amount: 350
- "350 reais" → amount: 350
- "350 00" → amount: 350
- "trezentos e cinquenta" → amount: 350
- "mil reais" → amount: 1000

IMPORTANTE: Para datas:
- Se não mencionar data → usar data atual: "${currentYear}-${currentMonth.toString().padStart(2, '0')}-${currentDay.toString().padStart(2, '0')}"
- "dia 12 do 7" → "${currentYear}-07-12" (ano atual)
- "12/7" → "${currentYear}-07-12" (ano atual)
- "ontem" → calcular data de ontem baseado na data atual
- "anteontem" → calcular data de anteontem baseado na data atual
- "hoje" → usar data atual
- "semana passada" → calcular 7 dias atrás
- "mês passado" → calcular 1 mês atrás

Para datas relativas, calcule baseado na data atual:
- "ontem" = data atual - 1 dia
- "anteontem" = data atual - 2 dias
- "semana passada" = data atual - 7 dias
- "mês passado" = data atual - 30 dias

Exemplos de datas relativas (baseado na data atual ${currentDay}/${currentMonth}/${currentYear}):
- "ontem" → ${this.calculateRelativeDate('ontem')}
- "anteontem" → ${this.calculateRelativeDate('anteontem')}
- "semana passada" → ${this.calculateRelativeDate('semana passada')}

Responda APENAS em JSON válido:
{
  "description": "descrição da transação",
  "amount": valor_numerico,
  "payment_method": "método de pagamento ou null",
  "type": "revenue|expense",
  "confidence": 0.0-1.0,
  "date": "YYYY-MM-DD"
}

Exemplos de classificação:
- "Compra no supermercado, R$ 350,00 pago no Pix" → {"description": "Compra no supermercado", "amount": 350, "payment_method": "PIX", "type": "expense", "confidence": 0.95, "date": "${currentYear}-${currentMonth.toString().padStart(2, '0')}-${currentDay.toString().padStart(2, '0')}"}
- "Salário 5000 reais" → {"description": "Salário", "amount": 5000, "type": "revenue", "confidence": 0.9, "date": "${currentYear}-${currentMonth.toString().padStart(2, '0')}-${currentDay.toString().padStart(2, '0')}"}
- "Aluguel 2000" → {"description": "Aluguel", "amount": 2000, "type": "expense", "confidence": 0.9, "date": "${currentYear}-${currentMonth.toString().padStart(2, '0')}-${currentDay.toString().padStart(2, '0')}"}
- "Pagamento de fornecedor no dia 12 do 7, o valor de R$290,00" → {"description": "Pagamento de fornecedor", "amount": 290, "type": "expense", "confidence": 0.9, "date": "${currentYear}-07-12"}
- "Uber ontem 25 no cartão" → {"description": "Uber", "amount": 25, "payment_method": "Cartão", "type": "expense", "confidence": 0.9, "date": "${this.calculateRelativeDate('ontem')}"}

Palavras que indicam DESPESA: compra, aluguel, conta, uber, taxi, supermercado, farmácia, restaurante, gasolina, luz, água, internet, pagamento, fornecedor
Palavras que indicam RECEITA: salário, freelance, venda, reembolso, bônus, recebimento, pagamento recebido

Seja preciso e extraia apenas informações claramente presentes na transcrição.`;

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Você é um especialista em extrair informações financeiras de transcrições de áudio. Seja preciso e retorne apenas JSON válido.'
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
          
          // Validações básicas
          if (!result.amount || result.amount <= 0) {
            throw new Error('Valor monetário inválido ou não encontrado');
          }
          
          if (!result.description || result.description.trim() === '') {
            result.description = 'Transação';
          }
          
          if (!result.type || !['revenue', 'expense'].includes(result.type)) {
            result.type = 'expense'; // Padrão é despesa
          }
          
          // Validar e processar data
          if (!result.date) {
            // Se não há data, usar data atual
            result.date = `${currentYear}-${currentMonth.toString().padStart(2, '0')}-${currentDay.toString().padStart(2, '0')}`;
          } else {
            // Validar formato da data
            const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
            if (!dateRegex.test(result.date)) {
              // Se formato inválido, usar data atual
              result.date = `${currentYear}-${currentMonth.toString().padStart(2, '0')}-${currentDay.toString().padStart(2, '0')}`;
            }
          }
          
          this.logger.log('✅ Informações extraídas com IA:', result);
          return result;
        }
      }
      
      throw new Error('Resposta da IA não contém JSON válido');
      
    } catch (error) {
      this.logger.error('❌ Erro ao extrair informações com IA:', error);
      
      // Fallback para extração manual se IA falhar
      this.logger.log('🔄 Usando fallback manual...');
      return this.extractFinancialInfoManual(transcription);
    }
  }

  /**
   * Calcula data relativa baseada na data atual
   */
  private calculateRelativeDate(relativeTerm: string): string {
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth();
    const currentDay = currentDate.getDate();
    
    let targetDate = new Date(currentYear, currentMonth, currentDay);
    
    switch (relativeTerm.toLowerCase()) {
      case 'ontem':
        targetDate.setDate(currentDay - 1);
        break;
      case 'anteontem':
        targetDate.setDate(currentDay - 2);
        break;
      case 'semana passada':
        targetDate.setDate(currentDay - 7);
        break;
      case 'mês passado':
      case 'mes passado':
        targetDate.setMonth(currentMonth - 1);
        break;
      case 'hoje':
      default:
        targetDate = new Date(currentYear, currentMonth, currentDay);
        break;
    }
    
    const year = targetDate.getFullYear();
    const month = (targetDate.getMonth() + 1).toString().padStart(2, '0');
    const day = targetDate.getDate().toString().padStart(2, '0');
    
    return `${year}-${month}-${day}`;
  }

  /**
   * Fallback manual para extração de informações financeiras
   */
  private extractFinancialInfoManual(transcription: string): {
    description: string;
    amount: number;
    payment_method?: string;
    type: 'revenue' | 'expense';
    confidence: number;
    date?: string;
  } {
    try {
      this.logger.log('🔧 Extraindo informações manualmente:', transcription);
      
      const normalized = this.normalizeAudioTranscription(transcription);
      
      // Padrões para extrair valor monetário (melhorados)
      const amountPatterns = [
        /(\d+[.,]?\d*)\s*(?:reais?|real|r\$)/gi,
        /r\$\s*(\d+[.,]?\d*)/gi,
        /(\d+[.,]?\d*)/g
      ];
      
      let amount = 0;
      let amountMatch = null;
      
      // Tentar encontrar valor usando diferentes padrões
      for (const pattern of amountPatterns) {
        amountMatch = normalized.match(pattern);
        if (amountMatch) {
          amount = parseFloat(amountMatch[1].replace(',', '.'));
          break;
        }
      }
      
      if (!amount || amount <= 0) {
        throw new Error('Valor monetário não encontrado');
      }
      
      // Extrair descrição (remover valor e palavras desnecessárias)
      let description = normalized
        .replace(/\d+[.,]?\d*\s*(?:reais?|real|r\$)/gi, '')
        .replace(/\d+[.,]?\d*/g, '')
        .replace(/\b(no|em|dia|data|com|por|via|através|de|do|da|dos|das)\b/gi, '')
        .replace(/\b(dinheiro|cartão|pix|transferência|boleto)\b/gi, '')
        .trim();
      
      // Detectar método de pagamento
      let payment_method = undefined;
      if (normalized.includes('dinheiro')) payment_method = 'Dinheiro';
      else if (normalized.includes('cartão') || normalized.includes('cartao')) payment_method = 'Cartão';
      else if (normalized.includes('pix')) payment_method = 'PIX';
      else if (normalized.includes('transferência') || normalized.includes('transferencia')) payment_method = 'Transferência';
      else if (normalized.includes('boleto')) payment_method = 'Boleto';
      
      // Classificar como receita ou despesa baseado em palavras-chave
      const revenueKeywords = [
        'salário', 'salario', 'freelance', 'venda', 'reembolso', 'bônus', 'bonus',
        'recebimento', 'pagamento recebido', 'pix recebido', 'transferência recebida',
        'boleto recebido', 'comissão', 'comissao', 'investimento', 'rendimento'
      ];
      
      const expenseKeywords = [
        'compra', 'aluguel', 'conta', 'supermercado', 'uber', '99', 'taxi', 'ônibus',
        'metro', 'trem', 'gasolina', 'combustível', 'combustivel', 'luz', 'água',
        'agua', 'internet', 'telefone', 'celular', 'alimentação', 'alimentacao',
        'restaurante', 'lanche', 'café', 'cafe', 'farmácia', 'farmacia', 'medicamento'
      ];
      
      let type: 'revenue' | 'expense' = 'expense'; // Padrão é despesa
      let confidence = 0.7; // Confiança base
      
      const hasRevenueKeyword = revenueKeywords.some(keyword => 
        normalized.includes(keyword)
      );
      
      const hasExpenseKeyword = expenseKeywords.some(keyword => 
        normalized.includes(keyword)
      );
      
      if (hasRevenueKeyword && !hasExpenseKeyword) {
        type = 'revenue';
        confidence = 0.9;
      } else if (hasExpenseKeyword) {
        type = 'expense';
        confidence = 0.9;
      } else {
        // Se não tem palavras-chave específicas, usar heurística
        if (normalized.includes('recebido') || normalized.includes('ganho') || normalized.includes('entrada')) {
          type = 'revenue';
          confidence = 0.8;
        } else if (normalized.includes('gasto') || normalized.includes('pago') || normalized.includes('saída')) {
          type = 'expense';
          confidence = 0.8;
        }
      }
      
      // Obter data atual para fallback
      const currentDate = new Date();
      const currentDay = currentDate.getDate();
      const currentMonth = currentDate.getMonth() + 1;
      const currentYear = currentDate.getFullYear();
      const currentDateString = `${currentYear}-${currentMonth.toString().padStart(2, '0')}-${currentDay.toString().padStart(2, '0')}`;
      
      const result = {
        description: description || 'Transação',
        amount,
        payment_method,
        type,
        confidence,
        date: currentDateString // Usar data atual no fallback
      };
      
      this.logger.log('✅ Informações extraídas manualmente:', result);
      return result;
      
    } catch (error) {
      this.logger.error('❌ Erro ao extrair informações manualmente:', error);
      throw error;
    }
  }
} 
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LegalPrompt,
  LegalPromptType,
  PromptVariable,
  PromptExecution,
  PromptTemplate,
  LegalPromptConfig,
  CreatePromptDto,
  UpdatePromptDto,
  ExecutePromptDto,
  PromptSearchOptions,
} from './interfaces/legal-prompt.interface';

@Injectable()
export class LegalPromptsService {
  private readonly logger = new Logger(LegalPromptsService.name);
  private readonly config: LegalPromptConfig;
  private readonly prompts: Map<string, LegalPrompt> = new Map();
  private readonly templates: Map<string, PromptTemplate> = new Map();

  constructor(private configService: ConfigService) {
    this.config = {
      defaultJurisdiction: this.configService.get<string>('DEFAULT_JURISDICTION') || 'BR',
      supportedJurisdictions: this.configService.get<string>('SUPPORTED_JURISDICTIONS')?.split(',') || ['BR', 'PT', 'ES'],
      maxPromptLength: 10000,
      maxVariables: 20,
      cacheEnabled: true,
      versioningEnabled: true,
    };

    this.initializeDefaultPrompts();
  }

  /**
   * Inicializa prompts padrão para cada jurisdição
   */
  private initializeDefaultPrompts(): void {
    this.initializeBrazilianPrompts();
    this.initializePortuguesePrompts();
    this.initializeSpanishPrompts();
    this.logger.log(`Inicializados ${this.prompts.size} prompts jurídicos`);
  }

  /**
   * Prompts específicos para o Brasil
   */
  private initializeBrazilianPrompts(): void {
    const brazilianPrompts: CreatePromptDto[] = [
      {
        type: 'contract_analysis',
        jurisdiction: 'BR',
        title: 'Análise de Contrato - Brasil',
        description: 'Analisa contratos segundo a legislação brasileira',
        prompt: `Você é um advogado especialista em direito contratual brasileiro. Analise o seguinte contrato considerando:

1. **Legislação Aplicável**: Código Civil Brasileiro (Lei 10.406/2002)
2. **Princípios**: Autonomia da vontade, boa-fé objetiva, função social do contrato
3. **Cláusulas Obrigatórias**: Verificar presença de cláusulas essenciais
4. **Riscos Jurídicos**: Identificar possíveis problemas legais
5. **Sugestões**: Propor melhorias e cláusulas adicionais

**Contrato a ser analisado:**
{contract_content}

**Análise solicitada:**
{analysis_type}

Forneça uma análise detalhada e estruturada.`,
        variables: [
          { name: 'contract_content', type: 'string', required: true, description: 'Conteúdo do contrato a ser analisado' },
          { name: 'analysis_type', type: 'string', required: false, description: 'Tipo de análise solicitada', defaultValue: 'análise completa' }
        ]
      },
      {
        type: 'petition_drafting',
        jurisdiction: 'BR',
        title: 'Elaboração de Petição - Brasil',
        description: 'Elabora petições iniciais segundo o CPC brasileiro',
        prompt: `Você é um advogado especialista em direito processual civil brasileiro. Elabora a seguinte petição considerando:

1. **Legislação**: CPC (Lei 13.105/2015)
2. **Estrutura**: Requisitos do art. 319 do CPC
3. **Fundamentos**: Jurisprudência do STJ e STF
4. **Pedidos**: Claro, preciso e fundamentado

**Dados do caso:**
- **Partes**: {parties}
- **Fatos**: {facts}
- **Direito**: {legal_basis}
- **Pedidos**: {requests}

Elabore uma petição inicial completa e bem fundamentada.`,
        variables: [
          { name: 'parties', type: 'string', required: true, description: 'Identificação das partes (autor e réu)' },
          { name: 'facts', type: 'string', required: true, description: 'Fatos relevantes do caso' },
          { name: 'legal_basis', type: 'string', required: true, description: 'Fundamentos jurídicos' },
          { name: 'requests', type: 'string', required: true, description: 'Pedidos formulados' }
        ]
      }
    ];

    brazilianPrompts.forEach(prompt => this.createPrompt(prompt));
  }

  /**
   * Prompts específicos para Portugal
   */
  private initializePortuguesePrompts(): void {
    const portuguesePrompts: CreatePromptDto[] = [
      {
        type: 'contract_analysis',
        jurisdiction: 'PT',
        title: 'Análise de Contrato - Portugal',
        description: 'Analisa contratos segundo a legislação portuguesa',
        prompt: `Você é um advogado especialista em direito contratual português. Analise o seguinte contrato considerando:

1. **Legislação Aplicável**: Código Civil Português
2. **Princípios**: Autonomia da vontade, boa-fé, função social
3. **Cláusulas Obrigatórias**: Verificar conformidade legal
4. **Riscos Jurídicos**: Identificar problemas potenciais
5. **Sugestões**: Propor melhorias

**Contrato a ser analisado:**
{contract_content}

**Análise solicitada:**
{analysis_type}

Forneça uma análise detalhada e estruturada.`,
        variables: [
          { name: 'contract_content', type: 'string', required: true, description: 'Conteúdo do contrato a ser analisado' },
          { name: 'analysis_type', type: 'string', required: false, description: 'Tipo de análise solicitada', defaultValue: 'análise completa' }
        ]
      }
    ];

    portuguesePrompts.forEach(prompt => this.createPrompt(prompt));
  }

  /**
   * Prompts específicos para Espanha
   */
  private initializeSpanishPrompts(): void {
    const spanishPrompts: CreatePromptDto[] = [
      {
        type: 'contract_analysis',
        jurisdiction: 'ES',
        title: 'Análisis de Contrato - España',
        description: 'Analiza contratos según la legislación española',
        prompt: `Eres un abogado especialista en derecho contractual español. Analiza el siguiente contrato considerando:

1. **Legislación Aplicable**: Código Civil Español
2. **Principios**: Autonomía de la voluntad, buena fe, función social
3. **Cláusulas Obligatorias**: Verificar conformidad legal
4. **Riesgos Jurídicos**: Identificar problemas potenciales
5. **Sugerencias**: Proponer mejoras

**Contrato a analizar:**
{contract_content}

**Tipo de análisis solicitado:**
{analysis_type}

Proporciona un análisis detallado y estructurado.`,
        variables: [
          { name: 'contract_content', type: 'string', required: true, description: 'Contenido del contrato a analizar' },
          { name: 'analysis_type', type: 'string', required: false, description: 'Tipo de análisis solicitado', defaultValue: 'análisis completo' }
        ]
      }
    ];

    spanishPrompts.forEach(prompt => this.createPrompt(prompt));
  }

  /**
   * Cria um novo prompt
   */
  createPrompt(createData: CreatePromptDto): LegalPrompt {
    const id = this.generatePromptId(createData.type, createData.jurisdiction);
    
    const prompt: LegalPrompt = {
      id,
      type: createData.type,
      jurisdiction: createData.jurisdiction,
      title: createData.title,
      description: createData.description,
      prompt: createData.prompt,
      variables: createData.variables,
      version: '1.0.0',
      isActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: createData.metadata || {},
    };

    this.prompts.set(id, prompt);
    this.logger.log(`Prompt criado: ${id} - ${prompt.title}`);
    return prompt;
  }

  /**
   * Busca um prompt por ID
   */
  getPromptById(promptId: string): LegalPrompt | null {
    return this.prompts.get(promptId) || null;
  }

  /**
   * Busca prompts por critérios
   */
  searchPrompts(options: PromptSearchOptions): LegalPrompt[] {
    let results = Array.from(this.prompts.values());

    if (options.type) {
      results = results.filter(p => p.type === options.type);
    }

    if (options.jurisdiction) {
      results = results.filter(p => p.jurisdiction === options.jurisdiction);
    }

    if (options.isActive !== undefined) {
      results = results.filter(p => p.isActive === options.isActive);
    }

    if (options.search) {
      const searchLower = options.search.toLowerCase();
      results = results.filter(p => 
        p.title.toLowerCase().includes(searchLower) ||
        p.description.toLowerCase().includes(searchLower)
      );
    }

    // Aplicar paginação
    const offset = options.offset || 0;
    const limit = options.limit || 10;
    results = results.slice(offset, offset + limit);

    this.logger.log(`Busca de prompts: ${results.length} resultados encontrados`);
    return results;
  }

  /**
   * Executa um prompt com variáveis
   */
  executePrompt(executeData: ExecutePromptDto): string {
    const prompt = this.getPromptById(executeData.promptId);
    
    if (!prompt) {
      throw new NotFoundException(`Prompt não encontrado: ${executeData.promptId}`);
    }

    if (!prompt.isActive) {
      throw new Error(`Prompt inativo: ${executeData.promptId}`);
    }

    // Validar variáveis obrigatórias
    const missingVariables = prompt.variables
      .filter(v => v.required && !executeData.variables[v.name])
      .map(v => v.name);

    if (missingVariables.length > 0) {
      throw new Error(`Variáveis obrigatórias não fornecidas: ${missingVariables.join(', ')}`);
    }

    // Substituir variáveis no prompt
    let processedPrompt = prompt.prompt;
    prompt.variables.forEach(variable => {
      const value = executeData.variables[variable.name] || variable.defaultValue || '';
      const placeholder = `{${variable.name}}`;
      processedPrompt = processedPrompt.replace(new RegExp(placeholder, 'g'), String(value));
    });

    this.logger.log(`Prompt executado: ${executeData.promptId} para usuário ${executeData.userId}`);
    return processedPrompt;
  }

  /**
   * Atualiza um prompt
   */
  updatePrompt(promptId: string, updateData: UpdatePromptDto): LegalPrompt {
    const prompt = this.getPromptById(promptId);
    
    if (!prompt) {
      throw new NotFoundException(`Prompt não encontrado: ${promptId}`);
    }

    const updatedPrompt: LegalPrompt = {
      ...prompt,
      ...updateData,
      updatedAt: new Date().toISOString(),
    };

    this.prompts.set(promptId, updatedPrompt);
    this.logger.log(`Prompt atualizado: ${promptId}`);
    return updatedPrompt;
  }

  /**
   * Lista todos os tipos de prompt disponíveis
   */
  getPromptTypes(): LegalPromptType[] {
    return [
      'contract_analysis',
      'contract_drafting',
      'petition_drafting',
      'legal_opinion',
      'consultation',
      'document_review',
      'clause_suggestion',
      'risk_analysis',
      'jurisprudence_search',
      'legal_research',
    ];
  }

  /**
   * Obtém prompts por jurisdição
   */
  getPromptsByJurisdiction(jurisdiction: string): LegalPrompt[] {
    return Array.from(this.prompts.values())
      .filter(p => p.jurisdiction === jurisdiction && p.isActive);
  }

  /**
   * Gera ID único para prompt
   */
  private generatePromptId(type: LegalPromptType, jurisdiction: string): string {
    const timestamp = Date.now();
    return `${type}_${jurisdiction}_${timestamp}`;
  }

  /**
   * Obtém configuração do serviço
   */
  getConfig(): LegalPromptConfig {
    return this.config;
  }
}

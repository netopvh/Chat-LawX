export interface LegalPrompt {
  id: string;
  type: LegalPromptType;
  jurisdiction: string;
  title: string;
  description: string;
  prompt: string;
  variables: string[];
  version: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, any>;
}

export type LegalPromptType = 
  | 'contract_analysis'
  | 'contract_drafting'
  | 'petition_drafting'
  | 'legal_opinion'
  | 'consultation'
  | 'document_review'
  | 'clause_suggestion'
  | 'risk_analysis'
  | 'jurisprudence_search'
  | 'legal_research';

export interface PromptVariable {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'array';
  required: boolean;
  description: string;
  defaultValue?: any;
  options?: string[];
}

export interface PromptExecution {
  promptId: string;
  variables: Record<string, any>;
  jurisdiction: string;
  userId: string;
  executedAt: string;
  result?: string;
  error?: string;
}

export interface PromptTemplate {
  type: LegalPromptType;
  jurisdiction: string;
  template: string;
  variables: PromptVariable[];
  examples: string[];
}

export interface LegalPromptConfig {
  defaultJurisdiction: string;
  supportedJurisdictions: string[];
  maxPromptLength: number;
  maxVariables: number;
  cacheEnabled: boolean;
  versioningEnabled: boolean;
}

export interface CreatePromptDto {
  type: LegalPromptType;
  jurisdiction: string;
  title: string;
  description: string;
  prompt: string;
  variables: PromptVariable[];
  metadata?: Record<string, any>;
}

export interface UpdatePromptDto {
  title?: string;
  description?: string;
  prompt?: string;
  variables?: PromptVariable[];
  isActive?: boolean;
  metadata?: Record<string, any>;
}

export interface ExecutePromptDto {
  promptId: string;
  variables: Record<string, any>;
  jurisdiction: string;
  userId: string;
}

export interface PromptSearchOptions {
  type?: LegalPromptType;
  jurisdiction?: string;
  isActive?: boolean;
  limit?: number;
  offset?: number;
  search?: string;
}

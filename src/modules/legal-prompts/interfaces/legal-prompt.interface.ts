export interface LegalPrompt {
  id: string;
  jurisdiction: string;
  name: string;
  description?: string;
  content: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateLegalPromptDto {
  jurisdiction: string;
  name: string;
  description?: string;
  content: string;
  isActive?: boolean;
}

export interface UpdateLegalPromptDto {
  name?: string;
  description?: string;
  content?: string;
  isActive?: boolean;
}

export interface LegalPromptQueryOptions {
  jurisdiction?: string;
  isActive?: boolean;
  limit?: number;
  offset?: number;
}

export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface Conversation {
  id: string;
  userId: string;
  promptId: string;
  previousResponseId?: string;
  openaiThreadId?: string;
  openaiResponseId?: string;
  messages: ConversationMessage[];
  jurisdiction: string;
  status: 'active' | 'completed' | 'archived';
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateConversationDto {
  userId: string;
  promptId: string;
  previousResponseId?: string;
  openaiThreadId?: string;
  jurisdiction: string;
  initialMessage?: ConversationMessage;
}

export interface UpdateConversationDto {
  previousResponseId?: string;
  openaiThreadId?: string;
  openaiResponseId?: string;
  messages?: ConversationMessage[];
  status?: 'active' | 'completed' | 'archived';
}

export interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  system_fingerprint?: string;
}

export interface OpenAIRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  response_format?: {
    type: 'json_schema';
    json_schema: {
      name: string;
      schema: any;
      strict?: boolean;
    };
  };
  previous_response_id?: string;
  temperature?: number;
  max_tokens?: number;
}
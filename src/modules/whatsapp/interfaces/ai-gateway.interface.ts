export interface IAIGateway {
  executeCustomPrompt(
    prompt: string,
    model?: 'gpt-4o' | 'gpt-3.5-turbo' | 'gpt-4' | 'gemini-1.5-flash' | 'gemini-1.5-pro',
    system?: string,
    temperature?: number,
    maxTokens?: number
  ): Promise<string>;
}

export const AI_GATEWAY = 'AI_GATEWAY';



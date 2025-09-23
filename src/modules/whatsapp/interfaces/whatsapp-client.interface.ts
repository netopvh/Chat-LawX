import { Injectable } from '@nestjs/common';

export interface IWhatsAppClient {
  sendText(to: string, text: string, typingDelayMs?: number): Promise<void>;
  sendTyping(to: string, delayMs?: number): Promise<void>;
  sendImage(to: string, base64: string, caption?: string): Promise<void>;
}

// Token opcional para DI baseada em interface (não utilizado nesta fase)
export const WHATSAPP_CLIENT = 'WHATSAPP_CLIENT';



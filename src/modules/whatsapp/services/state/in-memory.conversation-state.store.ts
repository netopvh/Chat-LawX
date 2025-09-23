import { Injectable, Logger } from '@nestjs/common';
import { IConversationStateStore } from '../../interfaces/conversation-state-store.interface';

@Injectable()
export class InMemoryConversationStateStore implements IConversationStateStore<any> {
  private readonly logger = new Logger(InMemoryConversationStateStore.name);
  private readonly store = new Map<string, any>();

  get(phone: string): any | undefined {
    return this.store.get(phone);
  }

  set(phone: string, state: any): void {
    this.store.set(phone, state);
  }

  merge(phone: string, partial: Partial<any>): void {
    const current = this.store.get(phone) || {};
    this.store.set(phone, { ...current, ...partial });
  }

  clear(phone: string): void {
    this.store.delete(phone);
  }

  entries(): Array<{ phone: string; state: any }> {
    const result: Array<{ phone: string; state: any }> = [];
    for (const [phone, state] of this.store.entries()) {
      result.push({ phone, state });
    }
    return result;
  }
}



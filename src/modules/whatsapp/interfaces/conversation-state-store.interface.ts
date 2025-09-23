export interface IConversationStateStore<State = any> {
  get(phone: string): State | undefined;
  set(phone: string, state: State): void;
  merge(phone: string, partial: Partial<State>): void;
  clear(phone: string): void;
  entries(): Array<{ phone: string; state: State }>;
}

export const CONVERSATION_STATE_STORE = 'CONVERSATION_STATE_STORE';



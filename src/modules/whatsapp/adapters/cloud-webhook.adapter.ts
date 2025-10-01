export type InboundMedia =
  | { kind: 'text'; text: string }
  | { kind: 'audio'; mediaId: string; mimeType?: string }
  | { kind: 'document'; mediaId: string; filename?: string; mimeType?: string }
  | { kind: 'image'; mediaId: string; mimeType?: string };

export interface NormalizedInboundMessage {
  from: string; // wa_id
  timestamp?: number;
  messageId?: string;
  media: InboundMedia;
}

export class CloudWebhookAdapter {
  static extractMessages(payload: any): NormalizedInboundMessage[] {
    const out: NormalizedInboundMessage[] = [];
    if (!payload?.entry) return out;
    for (const entry of payload.entry) {
      for (const change of entry.changes || []) {
        const value = change.value;
        const messages = value?.messages || [];
        for (const msg of messages) {
          const base = {
            from: msg.from,
            timestamp: msg.timestamp ? Number(msg.timestamp) * 1000 : undefined,
          } as any;

          switch (msg.type) {
            case 'text':
              out.push({ ...base, messageId: msg.id, media: { kind: 'text', text: msg.text?.body || '' } });
              break;
            case 'audio':
              if (msg.audio?.id) out.push({ ...base, messageId: msg.id, media: { kind: 'audio', mediaId: msg.audio.id, mimeType: msg.audio?.mime_type } });
              break;
            case 'document':
              if (msg.document?.id) out.push({ ...base, messageId: msg.id, media: { kind: 'document', mediaId: msg.document.id, filename: msg.document?.filename, mimeType: msg.document?.mime_type } });
              break;
            case 'image':
              if (msg.image?.id) out.push({ ...base, messageId: msg.id, media: { kind: 'image', mediaId: msg.image.id, mimeType: msg.image?.mime_type } });
              break;
            default:
              break;
          }
        }
      }
    }
    return out;
  }
}



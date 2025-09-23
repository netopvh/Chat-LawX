import { WhatsAppClient } from '../../src/modules/whatsapp/services/clients/whatsapp.client';

describe('WhatsAppClient', () => {
  const config = {
    get: jest.fn((k: string) => {
      if (k === 'EVOLUTION_API_URL') return 'http://evo';
      if (k === 'EVOLUTION_INSTANCE_NAME') return 'inst';
      if (k === 'EVOLUTION_API_KEY') return 'key';
      return undefined;
    })
  } as any;
  const http = { post: jest.fn() } as any;
  let client: WhatsAppClient;

  beforeEach(() => {
    jest.resetAllMocks();
    client = new WhatsAppClient(config, http);
  });

  it('sends text message', async () => {
    http.post.mockResolvedValue({});
    await client.sendText('5511999999999', 'hello', 0);
    expect(http.post).toHaveBeenCalledWith('http://evo/message/sendText/inst', { number: '5511999999999', text: 'hello' }, expect.any(Object));
  });
});



import { SessionService } from '../../src/modules/whatsapp/services/session/session.service';

describe('SessionService', () => {
  const br = {
    findSessionByPhone: jest.fn(),
    updateLastMessageSent: jest.fn(),
    createSession: jest.fn(),
  } as any;
  const iberia = {
    findWhatsAppSessionByPhone: jest.fn(),
    createWhatsAppSession: jest.fn(),
    updateWhatsAppSession: jest.fn(),
    updateUserLastWhatsAppInteraction: jest.fn(),
    findUserByPhone: jest.fn(),
    createUser: jest.fn(),
    updateUserName: jest.fn(),
    findUserSubscription: jest.fn(),
    createFremiumSubscription: jest.fn(),
  } as any;
  let service: SessionService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new SessionService(br, iberia);
  });

  it('checkBrazilianUserSession calculates needsWelcomeBack', async () => {
    const now = Date.now();
    br.findSessionByPhone.mockResolvedValue({ last_message_sent: new Date(now - (61 * 60 * 1000)).toISOString(), name: 'A' });
    const res = await service.checkBrazilianUserSession('55999');
    expect(res.needsWelcomeBack).toBe(true);
  });
});



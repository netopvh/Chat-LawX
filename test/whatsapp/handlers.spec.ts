import { BrazilHandler } from '../../src/modules/whatsapp/handlers/brazil.handler';
import { PortugalHandler } from '../../src/modules/whatsapp/handlers/portugal.handler';
import { SpainHandler } from '../../src/modules/whatsapp/handlers/spain.handler';

describe('Jurisdiction Handlers', () => {
  const message = {} as any;
  const ctx = {
    processBrazilianMessage: jest.fn(),
    processPortugueseMessage: jest.fn(),
    processSpanishMessage: jest.fn(),
  } as any;

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('BrazilHandler delegates correctly', async () => {
    const h = new BrazilHandler();
    await h.process(message, 'p', 't', {}, { jurisdiction: 'BR' }, ctx);
    expect(ctx.processBrazilianMessage).toHaveBeenCalled();
  });

  it('PortugalHandler delegates correctly', async () => {
    const h = new PortugalHandler();
    await h.process(message, 'p', 't', {}, { jurisdiction: 'PT' }, ctx);
    expect(ctx.processPortugueseMessage).toHaveBeenCalled();
  });

  it('SpainHandler delegates correctly', async () => {
    const h = new SpainHandler();
    await h.process(message, 'p', 't', {}, { jurisdiction: 'ES' }, ctx);
    expect(ctx.processSpanishMessage).toHaveBeenCalled();
  });
});




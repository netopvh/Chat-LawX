import { UpgradeFlowEngine } from '../../src/modules/whatsapp/services/upgrade/upgrade-flow.engine';

describe('UpgradeFlowEngine', () => {
  let engine: UpgradeFlowEngine;
  const aiService = {
    analyzePlanUpgradeIntent: jest.fn(),
    detectNewPlanUpgradeIntent: jest.fn(),
  } as any;

  beforeEach(() => {
    jest.resetAllMocks();
    engine = new UpgradeFlowEngine(aiService);
  });

  it('routes to payment_confirmation', async () => {
    aiService.analyzePlanUpgradeIntent.mockResolvedValue({ intent: 'payment_confirmation' });
    const delegates = {
      handlePaymentConfirmation: jest.fn(),
      handleFrequencySelectionWithAI: jest.fn(),
      handlePlanSelectionWithAI: jest.fn(),
      handleCancelUpgrade: jest.fn(),
      handleContinueUpgrade: jest.fn(),
    };
    await engine.route('p', 'u', 'm', { current_step: 'x' }, { upgradeStep: 'x' }, delegates);
    expect(delegates.handlePaymentConfirmation).toHaveBeenCalled();
  });

  it('routes to frequency_selection', async () => {
    aiService.analyzePlanUpgradeIntent.mockResolvedValue({ intent: 'frequency_selection' });
    const delegates = {
      handlePaymentConfirmation: jest.fn(),
      handleFrequencySelectionWithAI: jest.fn(),
      handlePlanSelectionWithAI: jest.fn(),
      handleCancelUpgrade: jest.fn(),
      handleContinueUpgrade: jest.fn(),
    };
    await engine.route('p', 'u', 'm', {}, {}, delegates);
    expect(delegates.handleFrequencySelectionWithAI).toHaveBeenCalled();
  });
});



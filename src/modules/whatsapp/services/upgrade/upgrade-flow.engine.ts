import { Injectable, Logger } from '@nestjs/common';
import { AiService } from '../../../ai/ai.service';

export interface UpgradeContext {
  currentStep?: string;
  selectedPlan?: string;
  selectedFrequency?: 'monthly' | 'yearly';
  amount?: number;
  sessionId?: string;
}

export interface UpgradeDelegates {
  handlePaymentConfirmation: (phone: string, userId: string, ctx: UpgradeContext) => Promise<void>;
  handleFrequencySelectionWithAI: (phone: string, userId: string, userMessage: string, ctx: UpgradeContext) => Promise<void>;
  handlePlanSelectionWithAI: (phone: string, userId: string, userMessage: string, ctx: UpgradeContext) => Promise<void>;
  handleCancelUpgrade: (phone: string, userId: string, session: any) => Promise<void>;
  handleContinueUpgrade: (phone: string, userId: string, userMessage: string, ctx: UpgradeContext) => Promise<void>;
}

@Injectable()
export class UpgradeFlowEngine {
  private readonly logger = new Logger(UpgradeFlowEngine.name);

  constructor(private readonly aiService: AiService) {}

  private buildContext(session: any, state: any): UpgradeContext {
    return {
      currentStep: session?.current_step || state?.upgradeStep,
      selectedPlan: session?.plan_name || state?.selectedPlan,
      selectedFrequency: (session?.billing_cycle || state?.selectedFrequency) as 'monthly' | 'yearly' | undefined,
      amount: session?.amount || 0,
      sessionId: session?.id,
    };
  }

  async route(
    phone: string,
    userId: string,
    userMessage: string,
    activeSession: any,
    state: any,
    delegates: UpgradeDelegates
  ): Promise<void> {
    const ctx = this.buildContext(activeSession, state);
    const aiAnalysis = await this.aiService.analyzePlanUpgradeIntent(userMessage, ctx);

    switch (aiAnalysis.intent) {
      case 'payment_confirmation':
        await delegates.handlePaymentConfirmation(phone, userId, ctx);
        break;
      case 'frequency_selection':
        await delegates.handleFrequencySelectionWithAI(phone, userId, userMessage, ctx);
        break;
      case 'plan_selection':
        await delegates.handlePlanSelectionWithAI(phone, userId, userMessage, ctx);
        break;
      case 'cancel_upgrade':
        await delegates.handleCancelUpgrade(phone, userId, activeSession);
        break;
      case 'continue_upgrade':
      default:
        await delegates.handleContinueUpgrade(phone, userId, userMessage, ctx);
        break;
    }
  }

  async detectNewIntent(userMessage: string): Promise<{ isUpgradeIntent: boolean; confidence: number }> {
    const result = await this.aiService.detectNewPlanUpgradeIntent(userMessage);
    return { isUpgradeIntent: result.isUpgradeIntent, confidence: result.confidence };
  }
}



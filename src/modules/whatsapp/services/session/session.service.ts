import { Injectable, Logger } from '@nestjs/common';
import { BrazilSessionRepository } from './brazil-session.repository';
import { IberiaSessionRepository } from './iberia-session.repository';

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly brRepo: BrazilSessionRepository,
    private readonly iberiaRepo: IberiaSessionRepository,
  ) {}

  // ===== BR =====
  async checkBrazilianUserSession(phone: string): Promise<{ session: any | null; needsWelcomeBack: boolean; timeSinceLastMessage: number; }> {
    const data = await this.brRepo.findSessionByPhone(phone);
    if (!data) {
      return { session: null, needsWelcomeBack: false, timeSinceLastMessage: 0 };
    }
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const lastMessageTime = data.last_message_sent ? new Date(data.last_message_sent).getTime() : 0;
    const currentTime = Date.now();
    const timeSinceLastMessage = currentTime - lastMessageTime;
    const needsWelcomeBack = timeSinceLastMessage > ONE_HOUR_MS;
    return { session: data, needsWelcomeBack, timeSinceLastMessage };
  }

  async updateBrazilLastMessageSent(phone: string): Promise<void> {
    await this.brRepo.updateLastMessageSent(phone);
  }

  async createBrazilianUserSession(phone: string, name: string): Promise<any> {
    return await this.brRepo.createSession(phone, name);
  }

  // ===== PT/ES =====
  async checkWhatsAppSession(phone: string, jurisdiction: string): Promise<{ session: any | null; needsWelcomeBack: boolean; timeSinceLastMessage: number; }> {
    const session = await this.iberiaRepo.findWhatsAppSessionByPhone(phone);
    if (!session) {
      return { session: null, needsWelcomeBack: false, timeSinceLastMessage: 0 };
    }
    const timeSinceLastMessage = Date.now() - session.lastMessageSent.getTime();
    const oneHourInMs = 60 * 60 * 1000;
    const needsWelcomeBack = timeSinceLastMessage > oneHourInMs;
    return { session, needsWelcomeBack, timeSinceLastMessage };
  }

  async createWhatsAppSession(phone: string, name: string, jurisdiction: string): Promise<any> {
    const cleanPhone = phone.replace(/\D/g, '');
    const ddi = jurisdiction === 'ES' ? '34' : '351';

    // Usuário
    let existingUser = await this.iberiaRepo.findUserByPhone(cleanPhone);
    let user = existingUser;
    if (!existingUser) {
      user = await this.iberiaRepo.createUser({ phone: cleanPhone, ddi, jurisdiction, name });
      try {
        await this.iberiaRepo.createFremiumSubscription(user.id, jurisdiction);
      } catch (e) {
        this.logger.error('Erro ao criar assinatura Fremium:', e);
      }
    } else {
      if (existingUser.name !== name) {
        await this.iberiaRepo.updateUserName(existingUser.id, name);
      }
      try {
        const activeSubscription = await this.iberiaRepo.findUserSubscription(existingUser.id);
        if (!activeSubscription) {
          await this.iberiaRepo.createFremiumSubscription(existingUser.id, jurisdiction);
        }
      } catch (e) {
        this.logger.error('Erro ao verificar/criar assinatura:', e);
      }
    }

    const session = await this.iberiaRepo.createWhatsAppSession({ phone: cleanPhone, name, jurisdiction, ddi });
    await this.iberiaRepo.updateUserLastWhatsAppInteraction(cleanPhone);
    return session;
  }

  async updateWhatsAppLastMessageSent(phone: string): Promise<void> {
    await this.iberiaRepo.updateWhatsAppSession(phone, { lastMessageSent: new Date(), isActive: true });
    await this.iberiaRepo.updateUserLastWhatsAppInteraction(phone);
  }
}



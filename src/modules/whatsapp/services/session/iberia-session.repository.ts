import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class IberiaSessionRepository {
  private readonly logger = new Logger(IberiaSessionRepository.name);

  constructor(private readonly prismaService: PrismaService) {}

  private normalizePhone(phone: string): string {
    return phone.replace(/\D/g, '');
  }

  async findWhatsAppSessionByPhone(phone: string): Promise<any | null> {
    return await this.prismaService.findWhatsAppSessionByPhone(this.normalizePhone(phone));
  }

  async createWhatsAppSession(data: { phone: string; name: string; jurisdiction: string; ddi: string }): Promise<any> {
    return await this.prismaService.createWhatsAppSession({
      phone: this.normalizePhone(data.phone),
      name: data.name,
      jurisdiction: data.jurisdiction,
      ddi: data.ddi,
    });
  }

  async updateWhatsAppSession(phone: string, data: any): Promise<void> {
    await this.prismaService.updateWhatsAppSession(this.normalizePhone(phone), data);
  }

  async updateUserLastWhatsAppInteraction(phone: string): Promise<void> {
    await this.prismaService.updateUserLastWhatsAppInteraction(this.normalizePhone(phone));
  }

  async findUserByPhone(phone: string): Promise<any | null> {
    return await this.prismaService.findUserByPhone(this.normalizePhone(phone));
  }

  async createUser(user: { phone: string; ddi: string; jurisdiction: string; name: string }): Promise<any> {
    return await (this.prismaService as any).user.create({
      data: {
        phone: this.normalizePhone(user.phone),
        ddi: user.ddi,
        jurisdiction: user.jurisdiction,
        name: user.name,
        isRegistered: true,
      },
    });
  }

  async updateUserName(userId: string, name: string): Promise<void> {
    await (this.prismaService as any).user.update({ where: { id: userId }, data: { name } });
  }

  async findUserSubscription(userId: string): Promise<any | null> {
    return await this.prismaService.findUserSubscription(userId);
  }

  async createFremiumSubscription(userId: string, jurisdiction: string): Promise<void> {
    await this.prismaService.createFremiumSubscription(userId, jurisdiction);
  }
}



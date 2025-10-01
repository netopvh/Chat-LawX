import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class WebhookSecurityService {
  constructor(private readonly configService: ConfigService) {}

  verifyCloudSignature(signatureHeader: string | undefined, rawBody: Buffer | undefined): boolean {
    if (!signatureHeader || !rawBody) return false;
    const appSecret = this.configService.get<string>('WHATSAPP_CLOUD_APP_SECRET');
    if (!appSecret) return false;

    const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

    try {
      const sig = Buffer.from(signatureHeader);
      const exp = Buffer.from(expected);
      if (sig.length !== exp.length) return false;
      return crypto.timingSafeEqual(sig, exp);
    } catch {
      return false;
    }
  }
}



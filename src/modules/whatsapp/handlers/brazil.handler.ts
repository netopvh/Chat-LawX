import { Injectable } from '@nestjs/common';
import { IJurisdictionHandler, JurisdictionHandlerContext } from '../interfaces/jurisdiction-handler.interface';

@Injectable()
export class BrazilHandler implements IJurisdictionHandler {
  async process(message: any, phone: string, text: string, state: any, jurisdiction: any, ctx: JurisdictionHandlerContext): Promise<void> {
    await ctx.processBrazilianMessage(message, phone, text, state, jurisdiction);
  }
}



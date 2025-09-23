import { Injectable } from '@nestjs/common';
import { BrazilHandler } from '../handlers/brazil.handler';
import { PortugalHandler } from '../handlers/portugal.handler';
import { SpainHandler } from '../handlers/spain.handler';

@Injectable()
export class JurisdictionRouter {
  constructor(
    private readonly br: BrazilHandler,
    private readonly pt: PortugalHandler,
    private readonly es: SpainHandler,
  ) {}

  resolve(jurisdiction: string) {
    switch (jurisdiction) {
      case 'BR':
        return this.br;
      case 'PT':
        return this.pt;
      case 'ES':
        return this.es;
      default:
        return this.br; // fallback seguro
    }
  }
}



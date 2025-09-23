export interface JurisdictionHandlerContext {
  processBrazilianMessage: (message: any, phone: string, text: string, state: any, jurisdiction: any) => Promise<void>;
  processPortugueseMessage: (message: any, phone: string, text: string, state: any, jurisdiction: any) => Promise<void>;
  processSpanishMessage: (message: any, phone: string, text: string, state: any, jurisdiction: any) => Promise<void>;
}

export interface IJurisdictionHandler {
  process(
    message: any,
    phone: string,
    text: string,
    state: any,
    jurisdiction: any,
    ctx: JurisdictionHandlerContext
  ): Promise<void>;
}



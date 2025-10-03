import { BadRequestException, Controller, Get, Post, Query, Body, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlansService } from '../plans/plans.service';
import { StripeService } from '../stripe/stripe.service';
import { UsersService } from '../users/users.service';
import { JurisdictionService } from '../jurisdiction/jurisdiction.service';
import { ExternalTokenGuard } from '../../common/guards/external-token.guard';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';

@Controller('external')
export class ExternalController {
  constructor(
    private readonly plansService: PlansService,
    private readonly stripeService: StripeService,
    private readonly usersService: UsersService,
    private readonly jurisdictionService: JurisdictionService,
    private readonly configService: ConfigService,
  ) {
    this.testNumbersForESFlow = this.parseTestNumbersFromEnv();
  }

  // Array de números para forçar fluxo ES via variável de ambiente TEST_NUMBERS
  private testNumbersForESFlow: string[] = [];

  private parseTestNumbersFromEnv(): string[] {
    try {
      const raw = this.configService.get<string>('TEST_NUMBERS');
      if (!raw) return [];
      return raw
        .split(',')
        .map((n) => n.trim())
        .map((n) => n.replace(/\D/g, ''))
        .map((n) => n.replace(/^0+/, ''))
        .filter((n) => n.length > 0);
    } catch (error) {
      return [];
    }
  }

  /**
   * Endpoint público para listar planos disponíveis por intervalo
   */
  @Get('plans')
  async listPlans(
    @Query('interval') interval: 'monthly' | 'yearly',
    @Query('jurisdiction') jurisdiction?: string,
  ) {
    if (!interval || (interval !== 'monthly' && interval !== 'yearly')) {
      throw new BadRequestException('Parâmetro interval inválido. Use "monthly" ou "yearly"');
    }

    const plans = await this.plansService.getUpgradePlans(jurisdiction);

    const filtered = plans
      .filter(p => (interval === 'monthly' ? p.monthly_price > 0 : p.yearly_price > 0))
      .map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        price: interval === 'monthly' ? p.monthly_price : p.yearly_price,
        interval,
        currency: this.jurisdictionService.getCurrency(p.jurisdiction),
        stripe_price_id: interval === 'monthly' ? p.stripe_price_id_monthly : p.stripe_price_id_yearly,
        features: p.features || [],
        jurisdiction: p.jurisdiction,
      }));

    return { success: true, data: filtered };
  }

  /**
   * Cria sessão de checkout do Stripe para assinatura
   * Protegido por token no header: x-external-token
   */
  @UseGuards(ExternalTokenGuard)
  @Post('checkout-session')
  async createCheckoutSession(@Body() dto: CreateCheckoutSessionDto) {
    const { phone, email, plan_id, interval, jurisdiction: forcedJurisdiction, success_url } = dto;

    // Validar plano
    const plan = await this.plansService.getPlanById(plan_id);
    if (!plan || !plan.is_active) {
      throw new BadRequestException('Plano inválido ou inativo');
    }

    const priceId = interval === 'monthly' ? plan.stripe_price_id_monthly : plan.stripe_price_id_yearly;
    if (!priceId) {
      throw new BadRequestException(`Plano não possui preço Stripe para o intervalo ${interval}`);
    }

    // Detectar jurisdição
    let jurisdictionInfo = forcedJurisdiction
      ? this.jurisdictionService.getJurisdictionConfig(forcedJurisdiction) || this.jurisdictionService.detectJurisdiction(phone)
      : this.jurisdictionService.detectJurisdiction(phone);

    // Forçar ES para números de teste configurados em TEST_NUMBERS
    const cleanPhone = (phone || '').replace(/\D/g, '').replace(/^0+/, '');
    if (this.testNumbersForESFlow.includes(cleanPhone)) {
      jurisdictionInfo = { ...jurisdictionInfo, jurisdiction: 'ES', isForced: true } as any;
    }

    console.log('jurisdictionInfo', jurisdictionInfo);
    console.log('phone', phone);
    console.log('email', email);
    console.log('plan', plan);
    console.log('interval', interval);
    console.log('success_url', success_url);
    console.log('priceId', priceId);

    // Garantir usuário (PT/ES criamos/retornamos; BR exige cadastro prévio)
    const user = await this.usersService.getOrCreateUser(phone, jurisdictionInfo.jurisdiction);
    if (!user) {
      throw new BadRequestException('Usuário não encontrado para este telefone. Crie a conta antes de assinar.');
    }

    // Criar sessão de checkout
    const checkoutUrl = await this.stripeService.createSimpleCheckoutSession({
      priceId: priceId,
      customerEmail: email,
      successUrl: success_url,
      metadata: {
        userId: user.id,
        planName: plan.name,
        planId: plan.id,
        billingCycle: interval,
        jurisdiction: jurisdictionInfo.jurisdiction,
        phone,
        email,
        source: 'external-api',
      },
    });

    return {
      success: true,
      data: {
        checkout_url: checkoutUrl,
      },
    };
  }
}



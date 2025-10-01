import { Controller, Post, Body, HttpCode, HttpStatus, Get, Query, Res, Req, BadRequestException, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { WhatsAppService } from './whatsapp.service';
import { WebhookDto } from './dto/webhook.dto';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { WebhookSecurityService } from './services/security/webhook-security.service';

@ApiTags('whatsapp')
@Controller('whatsapp')
export class WhatsAppController {
  constructor(
    private readonly whatsAppService: WhatsAppService,
    private readonly configService: ConfigService,
    private readonly webhookSecurity: WebhookSecurityService,
  ) {}

  @Get('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validação do Webhook do WhatsApp (GET)' })
  @ApiQuery({ name: 'hub.mode', required: false })
  @ApiQuery({ name: 'hub.verify_token', required: false })
  @ApiQuery({ name: 'hub.challenge', required: false })
  async verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') verifyToken: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    const expectedToken = this.configService.get<string>('WHATSAPP_VERIFY_TOKEN');

    if (mode === 'subscribe' && verifyToken === expectedToken) {
      // Responde com o challenge em texto puro conforme exigido pela API Oficial
      return res.status(HttpStatus.OK).type('text/plain').send(challenge ?? '');
    }

    return res.status(HttpStatus.FORBIDDEN).json({ success: false, error: 'Invalid verification token' });
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Webhook para receber mensagens do WhatsApp' })
  @ApiResponse({ status: 200, description: 'Webhook processado com sucesso' })
  async webhook(@Body() webhookData: any, @Req() req: Request): Promise<{ success: boolean }> {
    console.log('🔔 Webhook recebido:', JSON.stringify(webhookData, null, 2));

    try {
      const isCloudPayload = webhookData?.object === 'whatsapp_business_account';
      const signature = req.headers['x-hub-signature-256'] as string | undefined;
      const rawBody = (req as any).rawBody as Buffer | undefined;

      if (isCloudPayload || signature) {
        // Verificação obrigatória
        const ok = this.webhookSecurity.verifyCloudSignature(signature, rawBody);
        if (!ok) throw new ForbiddenException('Invalid signature');
        await this.whatsAppService.handleCloudWebhook(webhookData);
      } else {
        await this.whatsAppService.handleWebhook(webhookData);
      }

      console.log('✅ Webhook processado com sucesso');
      return { success: true };
    } catch (error) {
      console.error('❌ Erro ao processar webhook:', error);
      throw error;
    }
  }
} 
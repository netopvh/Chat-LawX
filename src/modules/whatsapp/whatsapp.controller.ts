import { Controller, Post, Body, HttpCode, HttpStatus, Get, Query, Res, Req, BadRequestException, ForbiddenException, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { WhatsAppService } from './whatsapp.service';
import { WebhookDto } from './dto/webhook.dto';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { WebhookSecurityService } from './services/security/webhook-security.service';
import { MessagingLogService } from './services/logging/messaging-log.service';
import { ExternalTokenGuard } from '../../common/guards/external-token.guard';

@ApiTags('whatsapp')
@Controller('whatsapp')
export class WhatsAppController {
  constructor(
    private readonly whatsAppService: WhatsAppService,
    private readonly configService: ConfigService,
    private readonly webhookSecurity: WebhookSecurityService,
    private readonly messagingLog: MessagingLogService,
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

  @Get('history')
  @UseGuards(ExternalTokenGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Listar histórico de conversa (whatsapp_messages)' })
  @ApiQuery({ name: 'phone', required: false })
  @ApiQuery({ name: 'sessionId', required: false })
  @ApiQuery({ name: 'conversationId', required: false })
  @ApiQuery({ name: 'jurisdiction', required: false })
  @ApiQuery({ name: 'since', required: false, description: 'ISO datetime' })
  @ApiQuery({ name: 'until', required: false, description: 'ISO datetime' })
  @ApiQuery({ name: 'limit', required: false, description: '1..1000 (default 200)' })
  async listHistory(
    @Query('phone') phone?: string,
    @Query('sessionId') sessionId?: string,
    @Query('conversationId') conversationId?: string,
    @Query('jurisdiction') jurisdiction?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('limit') limit?: string,
  ) {
    if (!phone && !sessionId && !conversationId) {
      throw new BadRequestException('Informe pelo menos um filtro: phone, sessionId ou conversationId');
    }

    const rows = await this.messagingLog.fetchHistory({
      phone,
      sessionId,
      conversationId,
      jurisdiction,
      since,
      until,
      limit: limit ? Number(limit) : undefined,
    });

    const normalizedPhone = (phone || (rows[0]?.phone ?? '')).replace(/\D/g, '');
    const convId = conversationId || rows.find(r => !!r.conversationId)?.conversationId || null;
    const sessId = sessionId || rows[0]?.sessionId || null;

    const messages = rows.map(r => ({
      id: r.id,
      role: r.role, // 'user' | 'assistant' | 'system' | 'tool'
      author: r.role === 'user' ? 'user' : (r.role === 'system' ? 'system' : 'assistant'),
      direction: r.direction, // 'inbound' | 'outbound'
      type: r.messageType,
      content: r.content ?? null,
      contentUrl: r.contentUrl ?? null,
      contentJson: r.contentJson ?? null,
      model: r.model ?? null,
      tokenCount: r.tokenCount ?? null,
      replyToId: r.replyToId ?? null,
      createdAt: r.createdAt,
    }));

    return {
      success: true,
      data: {
        phone: normalizedPhone,
        sessionId: sessId,
        conversationId: convId,
        jurisdiction: jurisdiction || rows[0]?.jurisdiction || null,
        messages,
      },
    };
  }

  @Get('conversations')
  @UseGuards(ExternalTokenGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Listar conversas agrupadas (por sessionId/conversationId) com nome do usuário' })
  @ApiQuery({ name: 'phone', required: false })
  @ApiQuery({ name: 'jurisdiction', required: false })
  @ApiQuery({ name: 'since', required: false, description: 'ISO datetime' })
  @ApiQuery({ name: 'until', required: false, description: 'ISO datetime' })
  @ApiQuery({ name: 'limit', required: false, description: '1..500 (default 100)' })
  async listConversations(
    @Query('phone') phone?: string,
    @Query('jurisdiction') jurisdiction?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('limit') limit?: string,
  ) {
    const rows = await this.messagingLog.listConversations({
      phone,
      jurisdiction,
      since,
      until,
      limit: limit ? Number(limit) : undefined,
    });

    const conversations = rows.map(r => ({
      sessionId: r.sessionId,
      conversationId: r.conversationId,
      phone: r.phone,
      name: r.name,
      jurisdiction: r.jurisdiction,
      lastMessageAt: r.lastMessageAt,
      messagesCount: r.messagesCount,
    }));

    return { success: true, data: conversations };
  }
} 
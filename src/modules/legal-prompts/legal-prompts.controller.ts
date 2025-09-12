import { Controller, Get, Post, Put, Delete, Body, Param, Query } from '@nestjs/common';
import { LegalPromptsService } from './legal-prompts.service';
import {
  CreateLegalPromptDto,
  UpdateLegalPromptDto,
  LegalPromptQueryOptions,
  CreateConversationDto,
} from './interfaces/legal-prompt.interface';

@Controller('legal-prompts')
export class LegalPromptsController {
  constructor(private readonly legalPromptsService: LegalPromptsService) {}

  @Post()
  async createPrompt(@Body() createDto: CreateLegalPromptDto) {
    return this.legalPromptsService.createPrompt(createDto);
  }

  @Get()
  async getPrompts(@Query() options: LegalPromptQueryOptions) {
    return this.legalPromptsService.getPrompts(options);
  }

  @Get(':id')
  async getPromptById(@Param('id') id: string) {
    return this.legalPromptsService.getPromptById(id);
  }

  @Get('jurisdiction/:jurisdiction')
  async getActivePromptByJurisdiction(@Param('jurisdiction') jurisdiction: string) {
    return this.legalPromptsService.getActivePromptByJurisdiction(jurisdiction);
  }

  @Put(':id')
  async updatePrompt(@Param('id') id: string, @Body() updateDto: UpdateLegalPromptDto) {
    return this.legalPromptsService.updatePrompt(id, updateDto);
  }

  @Delete(':id')
  async deletePrompt(@Param('id') id: string) {
    await this.legalPromptsService.deletePrompt(id);
    return { message: 'Prompt desativado com sucesso' };
  }

  @Post('conversations')
  async createConversation(@Body() createDto: CreateConversationDto) {
    return this.legalPromptsService.createConversation(createDto);
  }

  @Get('conversations/user/:userId/jurisdiction/:jurisdiction')
  async getActiveConversationByUser(
    @Param('userId') userId: string,
    @Param('jurisdiction') jurisdiction: string
  ) {
    return this.legalPromptsService.getActiveConversationByUser(userId, jurisdiction);
  }

  @Post('initialize-defaults')
  async initializeDefaultPrompts() {
    await this.legalPromptsService.initializeDefaultPrompts();
    return { message: 'Prompts padrão inicializados com sucesso' };
  }
}

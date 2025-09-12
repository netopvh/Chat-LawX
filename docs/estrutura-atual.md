# Estrutura Atual do Projeto - MePoupeBot

## Visão Geral

O **MePoupeBot** é um assistente financeiro pessoal via WhatsApp que utiliza Inteligência Artificial para processar comprovantes financeiros, extrair dados automaticamente e fornecer relatórios detalhados sobre receitas e despesas dos usuários.

## Arquitetura do Sistema

### Tecnologias Principais

- **Backend**: NestJS (Node.js + TypeScript)
- **Banco de Dados**: Supabase (PostgreSQL)
- **Armazenamento**: Supabase Storage
- **IA**: OpenAI GPT-4o (principal) + Google Gemini (fallback)
- **OCR**: Tesseract.js
- **WhatsApp Gateway**: Evolution API
- **Pagamentos**: Mercado Pago (PIX)
- **Deploy**: Docker + Google Cloud Run

### Estrutura de Diretórios

```
src/
├── app.module.ts                 # Módulo principal da aplicação
├── main.ts                      # Ponto de entrada da aplicação
├── common/                      # Utilitários e DTOs compartilhados
│   ├── dto/                     # Data Transfer Objects
│   └── entities/                # Entidades do banco de dados
└── modules/                     # Módulos da aplicação
    ├── ai/                      # Processamento de IA
    ├── expenses/                # Gestão de despesas
    ├── revenues/                # Gestão de receitas
    ├── users/                   # Gestão de usuários
    ├── whatsapp/                # Integração WhatsApp
    ├── supabase/                # Cliente Supabase
    ├── mercadopago/             # Integração Mercado Pago
    ├── plans/                   # Gestão de planos
    ├── subscriptions/           # Gestão de assinaturas
    ├── usage/                   # Controle de uso/limites
    ├── upload/                  # Upload de arquivos
    └── upgrade-sessions/        # Sessões de upgrade
```

## Módulos Principais

### 1. WhatsApp Module (`whatsapp/`)
**Responsabilidade**: Processamento de mensagens do WhatsApp e orquestração do fluxo principal.

**Funcionalidades**:
- Recebimento de webhooks da Evolution API
- Processamento de mensagens de texto, imagem e áudio
- Gerenciamento de estados de conversa
- Fluxo de cadastro automático
- Fluxo de upgrade de planos
- Redirecionamento para relatórios

**Arquivos**:
- `whatsapp.service.ts` (2.433 linhas) - Lógica principal
- `whatsapp.controller.ts` - Endpoints de webhook
- `dto/webhook.dto.ts` - Validação de dados

### 2. AI Module (`ai/`)
**Responsabilidade**: Processamento de IA para extração de dados e geração de respostas.

**Funcionalidades**:
- Extração de dados de imagens (OCR + IA)
- Classificação de documentos (receita vs despesa)
- Processamento de áudio (transcrição + extração)
- Geração de respostas contextuais
- Detecção de intenções (relatórios, upgrades, lançamentos)
- Análise de sentimentos e contexto

**Arquivos**:
- `ai.service.ts` (2.594 linhas) - Lógica de IA
- `ai.module.ts` - Configuração do módulo

### 3. Expenses Module (`expenses/`)
**Responsabilidade**: Gestão de despesas dos usuários.

**Funcionalidades**:
- Criação de despesas
- Busca por período (dia, semana, mês)
- Relatórios detalhados
- Agrupamento por categoria
- Análise de formas de pagamento

**Arquivos**:
- `expenses.service.ts` (273 linhas)
- `expenses.controller.ts`
- `dto/create-expense.dto.ts`

### 4. Revenues Module (`revenues/`)
**Responsabilidade**: Gestão de receitas dos usuários.

**Funcionalidades**:
- Criação de receitas
- Busca por período
- Relatórios detalhados
- Classificação por tipo (salário, freelance, venda, etc.)
- Análise de fontes de receita

**Arquivos**:
- `revenues.service.ts` (215 linhas)
- `revenues.controller.ts`
- `dto/create-revenue.dto.ts`
- `interfaces/revenue.interface.ts`

### 5. Users Module (`users/`)
**Responsabilidade**: Gestão de usuários e autenticação.

**Funcionalidades**:
- Criação e busca de usuários
- Cadastro automático via WhatsApp
- Integração com Supabase Auth
- Criação automática de assinatura Fremium

**Arquivos**:
- `users.service.ts` (233 linhas)
- `users.controller.ts`
- `dto/create-user.dto.ts`

### 6. MercadoPago Module (`mercadopago/`)
**Responsabilidade**: Processamento de pagamentos via PIX.

**Funcionalidades**:
- Criação de pagamentos PIX
- Geração de QR codes
- Webhook de confirmação
- Ativação automática de planos
- Notificações de status

**Arquivos**:
- `mercadopago.service.ts` (620 linhas)
- `mercadopago.controller.ts`
- `mercadopago.interface.ts`

### 7. Usage Module (`usage/`)
**Responsabilidade**: Controle de limites e uso dos planos.

**Funcionalidades**:
- Verificação de limites por ação
- Tracking de uso mensal
- Geração de mensagens de upgrade
- Resumo de status de uso

**Arquivos**:
- `usage.service.ts` (465 linhas)
- `usage.interface.ts`

### 8. Plans Module (`plans/`)
**Responsabilidade**: Gestão de planos de assinatura.

**Funcionalidades**:
- Busca de planos ativos
- Planos de upgrade
- Cálculo de preços e descontos

**Arquivos**:
- `plans.service.ts`
- `plans.controller.ts`
- `plans.interface.ts`

### 9. Subscriptions Module (`subscriptions/`)
**Responsabilidade**: Gestão de assinaturas dos usuários.

**Funcionalidades**:
- Criação de assinaturas
- Busca de assinatura ativa
- Criação automática de assinatura Fremium

**Arquivos**:
- `subscriptions.service.ts`
- `subscriptions.interface.ts`

### 10. Supabase Module (`supabase/`)
**Responsabilidade**: Cliente e operações do Supabase.

**Funcionalidades**:
- Upload de imagens e áudios
- Operações de banco de dados
- Gerenciamento de storage

**Arquivos**:
- `supabase.service.ts` (89 linhas)
- `supabase.module.ts`

### 11. Upload Module (`upload/`)
**Responsabilidade**: Processamento e conversão de arquivos.

**Funcionalidades**:
- Upload de comprovantes
- Conversão de áudio para MP3
- Otimização de imagens

**Arquivos**:
- `upload.service.ts`
- `upload.module.ts`

### 12. Upgrade Sessions Module (`upgrade-sessions/`)
**Responsabilidade**: Gerenciamento de sessões de upgrade.

**Funcionalidades**:
- Criação de sessões de upgrade
- Tracking de progresso
- Mensagens de retry e erro

**Arquivos**:
- `upgrade-sessions.service.ts`
- `upgrade-sessions.interface.ts`

## Fluxo Principal da Aplicação

### 1. Cadastro de Usuário
```
WhatsApp → Webhook → WhatsAppService → UsersService → Supabase Auth
```

### 2. Processamento de Comprovante
```
Imagem/Áudio → WhatsAppService → AiService → Classificação → 
Extração de Dados → ExpensesService/RevenuesService → Supabase
```

### 3. Fluxo de Upgrade
```
Solicitação → WhatsAppService → PlansService → MercadoPagoService → 
PIX Generation → Webhook Confirmação → SubscriptionsService
```

### 4. Geração de Relatórios
```
Solicitação → WhatsAppService → ExpensesService + RevenuesService → 
AiService (formatação) → WhatsApp (resposta)
```

## Estrutura do Banco de Dados

### Tabelas Principais

1. **auth.users** (Supabase Auth)
   - Gerenciamento de usuários
   - Metadata com informações do usuário

2. **expenses**
   - Despesas dos usuários
   - Campos: amount, category, date, description, store_name, etc.

3. **revenues**
   - Receitas dos usuários
   - Campos: amount, category, date, description, revenue_type, source, etc.

4. **plans**
   - Planos de assinatura
   - Campos: name, monthly_price, yearly_price, limits, etc.

5. **subscriptions**
   - Assinaturas dos usuários
   - Campos: user_id, plan_id, status, billing_cycle, etc.

6. **usage_tracking**
   - Controle de uso mensal
   - Campos: user_id, expenses_count, revenues_count, reports_count, etc.

7. **payments**
   - Registro de pagamentos
   - Campos: user_id, mercado_pago_id, status, amount, etc.

8. **upgrade_sessions**
   - Sessões de upgrade
   - Campos: user_id, plan_name, current_step, status, etc.

## Configurações e Dependências

### Variáveis de Ambiente
```env
# Supabase
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY

# IA
OPENAI_API_KEY
GEMINI_API_KEY

# WhatsApp
EVOLUTION_API_URL
EVOLUTION_API_KEY
EVOLUTION_INSTANCE_NAME

# Mercado Pago
MERCADO_PAGO_ACCESS_TOKEN
MERCADO_PAGO_PUBLIC_KEY

# Aplicação
PORT
NODE_ENV
JWT_SECRET
```

### Dependências Principais
```json
{
  "@nestjs/common": "^10.0.0",
  "@nestjs/core": "^10.0.0",
  "@nestjs/config": "^3.1.1",
  "@nestjs/swagger": "^7.1.17",
  "@supabase/supabase-js": "^2.38.4",
  "@google/generative-ai": "^0.2.1",
  "openai": "^4.20.1",
  "tesseract.js": "^5.0.3",
  "axios": "^1.6.2",
  "sharp": "^0.34.3",
  "fluent-ffmpeg": "^2.1.3"
}
```

## Funcionalidades Implementadas

### ✅ Funcionalidades Ativas

1. **Cadastro Automático**
   - Registro via WhatsApp
   - Criação automática de assinatura Fremium

2. **Processamento de Comprovantes**
   - OCR com Tesseract.js
   - Classificação automática (receita vs despesa)
   - Extração de dados com IA
   - Suporte a imagens e áudios

3. **Gestão Financeira**
   - Registro de despesas e receitas
   - Categorização automática
   - Relatórios por período
   - Análise de formas de pagamento

4. **Sistema de Planos**
   - Plano Fremium (gratuito)
   - Planos Pro e Premium
   - Controle de limites
   - Upgrade via PIX

5. **Integração WhatsApp**
   - Webhook da Evolution API
   - Processamento de mídia
   - Estados de conversa
   - Respostas contextuais

6. **Pagamentos**
   - Geração de PIX via Mercado Pago
   - Webhook de confirmação
   - Ativação automática de planos

### 🔄 Funcionalidades em Desenvolvimento

1. **Dashboard Web**
   - Interface web para visualização
   - Gráficos e relatórios avançados
   - Exportação de dados

2. **Notificações**
   - Alertas de limite
   - Lembretes de pagamento
   - Resumos automáticos

## Pontos de Atenção para Refatoração

### 1. Complexidade dos Serviços
- **WhatsAppService**: 2.433 linhas - muito complexo
- **AiService**: 2.594 linhas - muitas responsabilidades
- Necessidade de quebrar em serviços menores

### 2. Acoplamento
- Muitas dependências entre módulos
- WhatsAppService conhece todos os outros serviços
- Necessidade de interfaces e injeção de dependência

### 3. Tratamento de Erros
- Falta de tratamento consistente de erros
- Logs dispersos
- Necessidade de middleware de erro global

### 4. Validação
- Validação inconsistente entre módulos
- DTOs podem ser mais robustos
- Necessidade de validação de negócio

### 5. Testes
- Ausência de testes unitários
- Ausência de testes de integração
- Necessidade de cobertura de código

### 6. Performance
- Processamento síncrono de IA
- Falta de cache
- Necessidade de otimização de queries

### 7. Segurança
- Validação de entrada
- Rate limiting
- Autenticação/autorização

## Recomendações para Refatoração

### 1. Arquitetura
- Implementar Clean Architecture
- Separar camadas (Domain, Application, Infrastructure)
- Usar DDD (Domain-Driven Design)

### 2. Serviços
- Quebrar WhatsAppService em múltiplos serviços
- Criar interfaces para desacoplamento
- Implementar Command/Query pattern

### 3. Banco de Dados
- Implementar migrations
- Adicionar índices para performance
- Considerar read replicas

### 4. Monitoramento
- Implementar logging estruturado
- Adicionar métricas e alertas
- Implementar health checks

### 5. Testes
- Implementar testes unitários
- Adicionar testes de integração
- Configurar CI/CD

### 6. Documentação
- Documentar APIs com OpenAPI
- Criar guias de desenvolvimento
- Documentar arquitetura

---

**Data da Análise**: 23/01/2025  
**Versão do Projeto**: 1.0.0  
**Analista**: AI Assistant


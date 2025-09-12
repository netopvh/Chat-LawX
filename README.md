# MePoupe Bot API

Assistente Financeiro Pessoal via WhatsApp com IA

## 🚀 Visão Geral

API backend para um assistente financeiro que permite aos usuários:
- Cadastrar-se automaticamente via WhatsApp
- Enviar fotos de comprovantes para extração automática de dados
- Receber relatórios e resumos financeiros
- Acessar dashboard web com visualizações

## 🛠️ Tecnologias

- **Framework:** NestJS (TypeScript)
- **Banco de Dados:** Supabase (PostgreSQL)
- **IA/OCR:** Tesseract.js + GPT-4o (com fallback para Gemini)
- **WhatsApp:** Evolution API
- **Documentação:** Swagger/OpenAPI
- **Upload:** Supabase Storage

## 📋 Pré-requisitos

- Node.js 18+
- npm ou yarn
- Conta no Supabase
- API Keys (OpenAI GPT-4o, Gemini fallback, Evolution API)

## 🔧 Instalação

1. **Clone o repositório**
```bash
git clone <repository-url>
cd mepoupe-bot-api
```

2. **Instale as dependências**
```bash
npm install
```

3. **Configure as variáveis de ambiente**
```bash
cp env.example .env
```

Edite o arquivo `.env` com suas credenciais:
```env
# Supabase Configuration
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

# AI Services
OPENAI_API_KEY=your_openai_api_key
GEMINI_API_KEY=your_gemini_api_key (opcional, usado como fallback)

# Evolution API (WhatsApp Gateway)
EVOLUTION_API_URL=http://localhost:8080
EVOLUTION_API_KEY=your_evolution_api_key
EVOLUTION_INSTANCE_NAME=your_instance_name

# Application
PORT=3000
NODE_ENV=development
JWT_SECRET=your_jwt_secret
```

4. **Configure o banco de dados**
Execute o SQL no Supabase:
```sql
-- Tabela de despesas (usuários ficam na tabela auth.users nativa)
create table expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  amount numeric not null,
  category text,
  date date not null,
  image_url text,
  description text,
  created_at timestamp default now(),
  updated_at timestamp default now()
);

-- Bucket para imagens
insert into storage.buckets (id, name, public) values ('receipts', 'receipts', true);

-- Política RLS para expenses (opcional - para segurança)
alter table expenses enable row level security;

create policy "Users can view their own expenses" on expenses
  for select using (auth.uid() = user_id);

create policy "Users can insert their own expenses" on expenses
  for insert with check (auth.uid() = user_id);
```

5. **Execute a aplicação**
```bash
# Desenvolvimento
npm run start:dev

# Produção
npm run build
npm run start:prod
```

## 📚 Documentação da API

Acesse a documentação Swagger em: `http://localhost:3000/api`

## 🔄 Fluxo do WhatsApp

### 1. Primeiro Contato
```
Usuário: Oi!
Bot: Olá! Sou seu assistente financeiro. Qual é o seu nome?
Usuário: João Silva
Bot: Olá João! Cadastro realizado com sucesso. Agora você pode me enviar fotos dos seus comprovantes para eu registrar suas despesas.
```

### 2. Envio de Comprovante
```
Usuário: [envia foto do comprovante]
Bot: ✅ Despesa registrada com sucesso!

💰 Valor: R$ 78,50
📂 Categoria: Alimentação
📅 Data: 2025-01-23
📝 Descrição: Pizza Delivery

Sua despesa foi salva automaticamente! Envie mais comprovantes quando quiser.
```

## 🏗️ Estrutura do Projeto

```
src/
├── common/                 # Utilitários e classes base
│   ├── dto/
│   └── entities/
├── modules/
│   ├── users/             # Gestão de usuários
│   ├── expenses/          # Gestão de despesas
│   ├── whatsapp/          # Integração WhatsApp
│   ├── ai/               # Processamento de IA
│   ├── supabase/         # Cliente Supabase
│   └── upload/           # Upload de arquivos
├── main.ts               # Ponto de entrada
└── app.module.ts         # Módulo principal
```

## 🔌 Endpoints Principais

### WhatsApp Webhook
- `POST /whatsapp/webhook` - Recebe mensagens do Evolution API

### Usuários
- `POST /users` - Criar usuário
- `GET /users/:id` - Buscar usuário por ID
- `GET /users/phone/:phone` - Buscar usuário por telefone

### Despesas
- `POST /expenses` - Criar despesa
- `GET /expenses/user/:userId` - Listar despesas do usuário
- `GET /expenses/summary/:userId` - Resumo de despesas

## 🧪 Testes

```bash
# Executar testes
npm run test

# Executar testes em modo watch
npm run test:watch

# Cobertura de testes
npm run test:cov
```

## 🚀 Deploy

### Google Cloud Run
```bash
# Build da imagem
docker build -t mepoupe-bot-api .

# Deploy
gcloud run deploy mepoupe-bot-api \
  --image gcr.io/PROJECT_ID/mepoupe-bot-api \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated
```

### Vercel
```bash
# Instalar Vercel CLI
npm i -g vercel

# Deploy
vercel --prod
```

## 🔧 Configuração do Evolution API

1. Instale e configure o Evolution API
2. Crie uma instância do WhatsApp
3. Configure o webhook para: `https://your-api.com/whatsapp/webhook`
4. Adicione as credenciais no `.env`

## 📊 Monitoramento

A aplicação inclui logs estruturados para monitoramento:
- Processamento de mensagens
- Upload de imagens
- Extração de dados
- Erros e exceções

## 🤝 Contribuição

1. Fork o projeto
2. Crie uma branch para sua feature (`git checkout -b feature/AmazingFeature`)
3. Commit suas mudanças (`git commit -m 'Add some AmazingFeature'`)
4. Push para a branch (`git push origin feature/AmazingFeature`)
5. Abra um Pull Request

## 📄 Licença

Este projeto está sob a licença MIT. Veja o arquivo `LICENSE` para mais detalhes.

## 📞 Suporte

Para suporte, envie um email para suporte@mepoupe.com ou abra uma issue no GitHub. 
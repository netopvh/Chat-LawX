# Projeto: Assistente Financeiro Pessoal via WhatsApp com IA

## Visão Geral

Um assistente financeiro pessoal acessível via WhatsApp, onde o usuário interage com uma IA que:
- Realiza cadastro automático.
- Recebe imagens de comprovantes e extrai informações automaticamente.
- Salva dados financeiros no Supabase.
- Fornece relatórios por mensagem.
- Possui um painel web (Next.js) com gráficos e tabelas.

---

## Tecnologias Utilizadas

- **Linguagem:** TypeScript
- **Backend/API:** Node.js + Protocol MCP
- **Banco de Dados:** Supabase (PostgreSQL)
- **Armazenamento:** Supabase Storage
- **IA:** OCR (Tesseract.js) + LLM (GPT-4o com fallback para Gemini)
- **WhatsApp Gateway:** Evolution API
- **Frontend:** Next.js com TailwindCSS
- **Deploy:** Vercel + Google Cloud Run

---

## MVP - Funcionalidades

1. **Cadastro automático via WhatsApp**
2. **Recebimento de imagens via Evolution API**
3. **Processamento OCR da imagem e extração de dados**
4. **Persistência no Supabase**
5. **Resposta com confirmação e resumo via WhatsApp**
6. **Relatórios por texto**
7. **Dashboard web com login e visualização de dados**

---

## Estrutura do Banco de Dados (Supabase)

```sql
-- Tabela de usuários
create table users (
  id uuid primary key default gen_random_uuid(),
  phone text unique not null,
  name text,
  created_at timestamp default now()
);

-- Tabela de despesas
create table expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  amount numeric not null,
  category text,
  date date not null,
  image_url text,
  description text,
  created_at timestamp default now()
);
```

---

## Exemplo de Fluxo no WhatsApp

```text
Usuário: Oi!
IA: Olá! Sou seu assistente financeiro. Qual seu nome?
Usuário: João Silva
IA: Cadastro feito! Pode me mandar suas notas agora.

Usuário envia imagem
IA: Aqui está o que encontrei:
- Valor: R$ 78,50
- Categoria: Alimentação
- Data: 12/07/2025
- Descrição: Pizza Delivery
Salvar? ✅

Usuário: Sim.
IA: Salvo com sucesso!
```

---

## Estrutura da API (Webhook)

- Endpoint configurado na Evolution API.
- Recebe mensagens e imagens.
- Realiza OCR e chama LLM com prompt.
- Salva os dados no Supabase.

---

## Prompt para IA

> "Extraia do texto abaixo os seguintes dados:  
> - Valor (em reais)  
> - Categoria do gasto (ex: Alimentação, Transporte)  
> - Data  
> - Descrição  
> Responda em JSON no seguinte formato:  
> ```json
> {
>   "amount": 00.00,
>   "category": "Categoria",
>   "date": "YYYY-MM-DD",
>   "description": "Descrição do gasto"
> }
> ```"

---

## Dashboard Web (Next.js)

- Autenticação via telefone (Supabase Auth)
- Página `/dashboard` com:
  - Gráfico de pizza por categoria
  - Lista de despesas
- Página `/login` com magic link ou token

---

## Continuidade

**Próximas Etapas Técnicas:**
1. Criar repositório e configurar projeto backend com webhook
2. Conectar Evolution API e testar recebimento de mensagens
3. Implementar OCR + LLM para extração de dados
4. Configurar e conectar Supabase (DB + Storage)
5. Criar frontend Next.js com login e visualização

**Extras futuros:**
- Upload manual pelo painel
- Exportação CSV
- Integração com contas bancárias
- IA preditiva de gastos

---

**Data do Documento:** 23/07/2025

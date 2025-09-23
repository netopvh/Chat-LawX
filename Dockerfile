FROM node:20-bookworm-slim

# Define ambiente e diretório de trabalho
ENV NODE_ENV=production \
    PORT=3030
WORKDIR /app

# Dependências de sistema necessárias pelo Prisma (OpenSSL no Debian)
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Habilita pnpm via corepack
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# Copia arquivos de dependências primeiro para cache eficiente
COPY package.json pnpm-lock.yaml ./

# Instala dependências incluindo dev (necessárias para build) e mantém cache
RUN pnpm install --frozen-lockfile --prod=false

# Copia possíveis schemas do Prisma para geração do client
COPY prisma ./prisma

# Gera client do Prisma se o projeto utilizar Prisma (ignora erro se não houver)
RUN pnpm exec prisma generate || true

# Copia o restante do código da aplicação
COPY . .

# Executa build se existir (por exemplo, TypeScript). Não falha se não existir.
RUN pnpm run build || echo "no build script"

# Remove dependências de desenvolvimento, mantendo apenas produção
# RUN pnpm prune --prod || true

EXPOSE 3030

# Comando padrão para iniciar a aplicação (tenta start:prod, fallback para node dist e start)
CMD ["sh", "-c", "pnpm run start:prod || node dist/main.js || pnpm run start"]



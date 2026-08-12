# 🚀 LEILÃO FÁCIL v2.0

Plataforma completa de leilão de centavos com PIX, influencers e painel administrativo.

## 📦 Arquivos do Projeto

```
leilao-facil-v2/
├── .env.example          # Template de variáveis de ambiente
├── .gitignore            # Arquivos ignorados pelo Git
├── package.json          # Dependências Node.js
├── server.js             # Servidor principal (Express + Socket.IO)
├── database.js           # Módulo SQLite (better-sqlite3)
├── public/
│   ├── index.html        # Tela do usuário (leilão)
│   └── admin.html        # Painel administrativo
└── uploads/              # Imagens de campanhas
```

## 🚀 Instalação

### 1. Instalar dependências
```bash
npm install
```

### 2. Configurar variáveis de ambiente
```bash
cp .env.example .env
```

Edite o arquivo `.env`:
```
PORT=3000
NODE_ENV=production
JWT_SECRET=sua_chave_super_secreta_aqui_minimo_32_caracteres
ADMIN_PASSWORD_HASH=$2a$10$...  # Gerar com bcrypt (veja abaixo)
MERCADO_PAGO_ACCESS_TOKEN=APP_USR-...
CHAVE_PIX=seu_email_ou_cpf_aqui
CORS_ORIGINS=https://seudominio.com
```

### 3. Gerar hash da senha admin
```bash
node -e "const bcrypt=require('bcryptjs'); bcrypt.hash('sua_senha',10).then(h=>console.log(h))"
```
Copie o hash gerado para `ADMIN_PASSWORD_HASH` no `.env`.

### 4. Iniciar servidor
```bash
npm start
```

Ou em desenvolvimento:
```bash
npm run dev
```

## 🔐 Segurança

- ✅ JWT para autenticação admin
- ✅ Bcrypt para hash de senha
- ✅ Helmet para headers de segurança
- ✅ Rate limiting anti-brute force
- ✅ CORS restrito por domínio
- ✅ Upload de imagens validado (5MB max)
- ✅ SQL Injection protegido (prepared statements)

## 💳 PIX

### Mercado Pago (recomendado)
1. Crie conta em [mercadopago.com.br](https://www.mercadopago.com.br)
2. Gere Access Token em: Desenvolvedores > Credenciais
3. Configure webhook: `/api/webhooks/mercado-pago`

### PIX Estático (fallback)
Se não configurar Mercado Pago, o sistema gera PIX estático com sua chave.

## 👥 Influencers

1. Crie influencers no painel admin
2. Cada influencer recebe um código único (ex: `joao2024`)
3. Link de divulgação: `https://seudominio.com/?ref=joao2024`
4. Comissão automática sobre cada lance confirmado

## 📊 Funcionalidades Admin

- Dashboard com estatísticas em tempo real
- CRUD completo de campanhas
- Ativar/Pausar/Finalizar/Resetar campanhas
- Timer automático (encerra sozinho no horário)
- Gerenciamento de influencers
- Exportação CSV de dados
- Configurações do sistema

## 🌐 Deploy

### Render (recomendado)
1. Crie conta em [render.com](https://render.com)
2. New Web Service > Connect GitHub
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Adicione variáveis de ambiente

### Railway
1. Crie conta em [railway.app](https://railway.app)
2. New Project > Deploy from GitHub
3. Adicione variáveis de ambiente

## 🛠️ Tecnologias

- Node.js 18+
- Express.js
- Socket.IO (tempo real)
- better-sqlite3 (banco de dados)
- JWT (autenticação)
- bcryptjs (hash de senha)
- Helmet (segurança)
- Multer (upload de imagens)
- node-cron (timer automático)

## 📞 Suporte

Para dúvidas ou problemas, entre em contato pelo painel admin ou consulte os logs do servidor.

---
**Versão:** 2.0.0 | **Autor:** Leilão Fácil Team

#!/usr/bin/env node
/**
 * Script de setup inicial do Leilão Fácil v2.0
 * Gera hash da senha admin e cria .env
 */

const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('🚀 LEILÃO FÁCIL v2.0 - Setup Inicial');
console.log('=====================================\n');

rl.question('Digite a senha do administrador: ', async (senha) => {
  if (!senha || senha.length < 6) {
    console.log('❌ Senha deve ter no mínimo 6 caracteres');
    rl.close();
    return;
  }

  const hash = await bcrypt.hash(senha, 10);

  rl.question('Digite sua chave PIX (email, CPF ou celular): ', (chavePix) => {
    rl.question('Digite o Access Token do Mercado Pago (ou deixe em branco): ', (mpToken) => {
      rl.question('Digite o domínio do site (ex: https://leilaofacil.com): ', (dominio) => {

        const envContent = `# LEILÃO FÁCIL v2.0 - CONFIGURAÇÃO
PORT=3000
NODE_ENV=production
JWT_SECRET=${require('crypto').randomBytes(32).toString('hex')}
ADMIN_PASSWORD_HASH=${hash}
CHAVE_PIX=${chavePix || 'leleko.pix@gmail.com'}
MERCADO_PAGO_ACCESS_TOKEN=${mpToken || ''}
CORS_ORIGINS=${dominio || 'http://localhost:3000'}
COMISSAO_PADRAO=10
`;

        fs.writeFileSync(path.join(__dirname, '.env'), envContent);
        console.log('\n✅ Arquivo .env criado com sucesso!');
        console.log('\nPróximos passos:');
        console.log('1. npm install');
        console.log('2. npm start');
        console.log('\nAcesse o admin em: ' + (dominio || 'http://localhost:3000') + '/admin.html');

        rl.close();
      });
    });
  });
});

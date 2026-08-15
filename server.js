/**
 * LEILAO FACIL v2.1 - Servidor Principal
 * Corrigido: await duplos, status padronizado, Socket.IO, robustez
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const multer = require('multer');
const axios = require('axios');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');

const db = require('./database-pg');

// ==========================================
// CONFIGURACAO
// ==========================================
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : '*',
    methods: ['GET', 'POST'],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'leilao-facil-secret-key-2024';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
const ADMIN_PASSWORD_PLAIN = process.env.ADMIN_PASSWORD_PLAIN;
const MP_ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN;
const CHAVE_PIX = process.env.CHAVE_PIX || 'leleko.pix@gmail.com';
const COMISSAO_PADRAO = parseInt(process.env.COMISSAO_PADRAO) || 10;

// ==========================================
// MIDDLEWARES DE SEGURANCA
// ==========================================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      connectSrc: ["'self'", "https://api.mercadopago.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000', 'http://127.0.0.1:3000'];

app.use(cors({
  origin: corsOrigins,
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.set('trust proxy', 1);

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { erro: 'Muitas requisicoes. Tente novamente em 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { erro: 'Muitas tentativas de login. Tente novamente em 1 minuto.' },
  skipSuccessfulRequests: true,
});

const lanceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { erro: 'Muitos lances em pouco tempo. Aguarde 1 minuto.' },
});

// ==========================================
// UPLOAD DE IMAGENS
// ==========================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'uploads'));
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Formato nao suportado. Use JPG, PNG, GIF ou WEBP.'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }
});

// ==========================================
// AUTENTICACAO JWT
// ==========================================
function gerarTokenAdmin() {
  return jwt.sign({ tipo: 'admin', iat: Date.now() }, JWT_SECRET, { expiresIn: '8h' });
}

function verificarTokenAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ erro: 'Token nao fornecido' });
  }

  const token = authHeader.substring(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.tipo !== 'admin') {
      return res.status(403).json({ erro: 'Acesso restrito ao administrador' });
    }
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ erro: 'Token invalido ou expirado' });
  }
}

// ==========================================
// FUNCOES AUXILIARES
// ==========================================
function gerarSlug(nome) {
  return nome
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function calcularCRC16(payload) {
  let crc = 0xFFFF;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) crc = (crc << 1) ^ 0x1021;
      else crc <<= 1;
      crc &= 0xFFFF;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function gerarPayloadPIX(nome, valor, descricao) {
  const v = valor.toFixed(2).replace('.', '');
  const n = nome.substring(0, 25).toUpperCase();
  const d = (descricao || 'Lance').substring(0, 25);

  let p = '000201010211';
  p += `26${String(14 + CHAVE_PIX.length).padStart(2, '0')}0014BR.GOV.BCB.PIX01${String(CHAVE_PIX.length).padStart(2, '0')}${CHAVE_PIX}`;
  p += '5204000053039865406' + v + '5802BR59';
  p += String(n.length).padStart(2, '0') + n;
  p += '6008SAO PAULO';
  p += '62' + String(4 + d.length).padStart(2, '0') + '05' + String(d.length).padStart(2, '0') + d;
  p += '6304';
  p += calcularCRC16(p);

  return p;
}

function formatarMoeda(valor) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valor);
}

function safeEmit(evento, dados) {
  try {
    io.emit(evento, dados);
  } catch (err) {
    console.error(`Erro ao emitir ${evento}:`, err.message);
  }
}

// ==========================================
// TIMER AUTOMATICO DE LEILAO
// ==========================================
const timersAtivos = new Map();

async function iniciarTimerCampanha(campanhaId) {
  if (timersAtivos.has(campanhaId)) {
    clearTimeout(timersAtivos.get(campanhaId));
  }

  const campanha = await db.buscarCampanhaPorId(campanhaId);
  if (!campanha || campanha.status !== 'ativa') return;

  const dataFim = new Date(campanha.data_fim);
  const agora = new Date();
  const msRestante = dataFim.getTime() - agora.getTime();

  if (msRestante <= 0) {
    finalizarCampanha(campanhaId);
    return;
  }

  console.log(`Timer iniciado para campanha ${campanhaId}: ${Math.round(msRestante / 1000)}s restantes`);

  const timeoutId = setTimeout(() => {
    finalizarCampanha(campanhaId);
  }, msRestante);

  timersAtivos.set(campanhaId, timeoutId);
}

function cancelarTimerCampanha(campanhaId) {
  if (timersAtivos.has(campanhaId)) {
    clearTimeout(timersAtivos.get(campanhaId));
    timersAtivos.delete(campanhaId);
    console.log(`Timer cancelado para campanha ${campanhaId}`);
  }
}

async function finalizarCampanha(campanhaId) {
  console.log(`Finalizando campanha ${campanhaId}...`);

  const campanha = await db.buscarCampanhaPorId(campanhaId);
  if (!campanha) return;

  await db.encerrarCampanha(campanhaId);
  cancelarTimerCampanha(campanhaId);

  const itens = await db.listarItensPorCampanha(campanhaId);
  const resultados = [];

  for (const item of itens) {
    if (item.status === 'encerrado') continue;

    const maiorLance = await db.buscarMaiorLance(item.id);

    if (maiorLance) {
      await db.encerrarItem(item.id, maiorLance.usuario_id);
      await db.atualizarLanceAtual(item.id, maiorLance.valor, maiorLance.usuario_id);

      resultados.push({
        itemId: item.id,
        itemNome: item.nome,
        vencedorId: maiorLance.usuario_id,
        vencedorNome: maiorLance.usuario_nome,
        valor: maiorLance.valor
      });

      if (campanha.influencer_id && campanha.comissao_ativa) {
        const influencer = await db.buscarInfluencerPorId(campanha.influencer_id);
        if (influencer) {
          const comissao = (maiorLance.valor * influencer.comissao_percentual) / 100;
          await db.registrarEventoInfluencer({
            influencer_id: influencer.id,
            campanha_id: campanhaId,
            usuario_id: maiorLance.usuario_id,
            tipo_evento: 'conversao',
            valor_evento: maiorLance.valor,
            comissao_gerada: comissao
          });
          await db.atualizarEstatisticasInfluencer(influencer.id);
        }
      }
    } else {
      await db.atualizarCampanha(item.id, { status: 'cancelado' });
    }
  }

  await db.atualizarTotaisCampanha(campanhaId);

  safeEmit('campanha_finalizada', {
    campanhaId,
    campanhaNome: campanha.nome,
    resultados,
    totalArrecadado: campanha.total_arrecadado
  });

  console.log(`Campanha ${campanhaId} finalizada. ${resultados.length} itens arrematados.`);
}

async function verificarCampanhasAtivas() {
  console.log('Verificando campanhas ativas...');
  try {
    const ativas = await db.listarCampanhasAtivas();
    for (const campanha of ativas) {
      const dataFim = new Date(campanha.data_fim);
      if (dataFim <= new Date()) {
        console.log(`Campanha ${campanha.id} expirada. Finalizando...`);
        finalizarCampanha(campanha.id);
      } else {
        iniciarTimerCampanha(campanha.id);
      }
    }
  } catch (err) {
    console.error('Erro ao verificar campanhas ativas:', err.message);
  }
}

cron.schedule('* * * * *', async () => {
  try {
    const ativas = await db.listarCampanhasAtivas();
    for (const campanha of ativas) {
      const dataFim = new Date(campanha.data_fim);
      if (dataFim <= new Date() && timersAtivos.has(campanha.id)) {
        console.log(`Cron detectou campanha ${campanha.id} expirada`);
        finalizarCampanha(campanha.id);
      }
    }
  } catch (err) {
    console.error('Erro no cron de campanhas:', err.message);
  }
});

// ==========================================
// SOCKET.IO - TEMPO REAL
// ==========================================
const usuariosOnline = new Map();

io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);

  socket.on('entrar_campanha', async (campanhaId) => {
    try {
      socket.join(`campanha_${campanhaId}`);
      console.log(`${socket.id} entrou na campanha ${campanhaId}`);

      const campanha = await db.buscarCampanhaPorId(campanhaId);
      const itens = await db.listarItensPorCampanha(campanhaId);

      socket.emit('estado_campanha', {
        campanha,
        itens,
        totalOnline: io.sockets.adapter.rooms.get(`campanha_${campanhaId}`)?.size || 1
      });
    } catch (err) {
      console.error('Erro ao entrar na campanha:', err.message);
    }
  });

  socket.on('sair_campanha', (campanhaId) => {
    socket.leave(`campanha_${campanhaId}`);
    console.log(`${socket.id} saiu da campanha ${campanhaId}`);
  });

  socket.on('novo_lance', async (data) => {
    const { campanhaId, itemId, usuarioId, valor } = data;

    try {
      const campanha = await db.buscarCampanhaPorId(campanhaId);
      if (!campanha || campanha.status !== 'ativa') {
        socket.emit('erro_lance', { mensagem: 'Campanha nao esta ativa' });
        return;
      }

      const item = await db.buscarItemPorId(itemId);
      if (!item || item.status !== 'ativo') {
        socket.emit('erro_lance', { mensagem: 'Item nao esta disponivel' });
        return;
      }

      if (valor < item.lance_minimo) {
        socket.emit('erro_lance', { mensagem: `Lance minimo: ${formatarMoeda(item.lance_minimo)}` });
        return;
      }

      const lance = await db.criarLance({
        item_id: itemId,
        campanha_id: campanhaId,
        usuario_id: usuarioId,
        valor: valor,
        ip_address: socket.handshake.address,
        user_agent: socket.handshake.headers['user-agent']
      });

      await db.atualizarLanceAtual(itemId, valor, usuarioId);
      await db.atualizarTotaisCampanha(campanhaId);

      const usuario = await db.buscarUsuarioPorId(usuarioId);

      safeEmit('lance_recebido', {
        lance: {
          id: lance.id,
          itemId,
          usuarioId,
          usuarioNome: usuario?.nome || 'Anonimo',
          valor,
          dataHora: new Date().toISOString()
        },
        itemAtualizado: {
          id: itemId,
          lanceAtual: valor,
          vencedorId: usuarioId,
          vencedorNome: usuario?.nome || 'Anonimo'
        }
      });

      console.log(`Novo lance: ${formatarMoeda(valor)} no item ${itemId} por ${usuario?.nome}`);

    } catch (err) {
      console.error('Erro no lance:', err);
      socket.emit('erro_lance', { mensagem: 'Erro ao processar lance' });
    }
  });

  socket.on('solicitar_timer', async (campanhaId) => {
    try {
      const campanha = await db.buscarCampanhaPorId(campanhaId);
      if (campanha) {
        const dataFim = new Date(campanha.data_fim);
        const restante = Math.max(0, dataFim.getTime() - Date.now());
        socket.emit('timer_atualizado', {
          campanhaId,
          restanteMs: restante,
          dataFim: campanha.data_fim
        });
      }
    } catch (err) {
      console.error('Erro ao solicitar timer:', err.message);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Cliente desconectado: ${socket.id}`);
    usuariosOnline.delete(socket.id);
  });
});

// ==========================================
// ROTAS PUBLICAS
// ==========================================

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    versao: '2.1.0'
  });
});

app.get('/api/campanhas/ativas', async (req, res) => {
  try {
    const campanhas = await db.listarCampanhasAtivas();
    res.json({ sucesso: true, campanhas });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar campanhas' });
  }
});

app.get('/api/campanhas/:slug', async (req, res) => {
  try {
    const campanha = await db.buscarCampanhaPorSlug(req.params.slug);
    if (!campanha) {
      return res.status(404).json({ erro: 'Campanha nao encontrada' });
    }

    const itens = await db.listarItensPorCampanha(campanha.id);
    const totalOnline = io.sockets.adapter.rooms.get(`campanha_${campanha.id}`)?.size || 0;

    res.json({
      sucesso: true,
      campanha: { ...campanha, itens, totalOnline }
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar campanha' });
  }
});

app.post('/api/usuarios', async (req, res) => {
  try {
    const { nome, email, telefone, cpf, influencer_ref } = req.body;

    if (!nome || nome.trim().length < 3) {
      return res.status(400).json({ erro: 'Nome e obrigatorio (minimo 3 caracteres)' });
    }

    if (cpf) {
      const existente = await db.buscarUsuarioPorCPF(cpf);
      if (existente) {
        return res.json({ sucesso: true, usuario: existente, existente: true });
      }
    }

    if (email) {
      const existente = await db.buscarUsuarioPorEmail(email);
      if (existente) {
        return res.json({ sucesso: true, usuario: existente, existente: true });
      }
    }

    if (influencer_ref) {
      const influencer = await db.buscarInfluencerPorCodigo(influencer_ref);
      if (influencer) {
        await db.registrarEventoInfluencer({
          influencer_id: influencer.id,
          tipo_evento: 'clique',
          ip_address: req.ip,
          user_agent: req.headers['user-agent']
        });
      }
    }

    const usuario = await db.criarUsuario({ nome, email, telefone, cpf, influencer_ref });

    if (influencer_ref) {
      const influencer = await db.buscarInfluencerPorCodigo(influencer_ref);
      if (influencer) {
        await db.registrarEventoInfluencer({
          influencer_id: influencer.id,
          usuario_id: usuario.id,
          tipo_evento: 'cadastro',
          ip_address: req.ip,
          user_agent: req.headers['user-agent']
        });
        await db.atualizarEstatisticasInfluencer(influencer.id);
      }
    }

    res.status(201).json({ sucesso: true, usuario });
  } catch (err) {
    console.error('Erro ao criar usuario:', err);
    res.status(500).json({ erro: 'Erro ao cadastrar usuario' });
  }
});

app.get('/api/usuarios/:id', async (req, res) => {
  try {
    const usuario = await db.buscarUsuarioPorId(req.params.id);
    if (!usuario) {
      return res.status(404).json({ erro: 'Usuario nao encontrado' });
    }

    const lances = await db.listarLancesPorUsuario(usuario.id);
    res.json({ sucesso: true, usuario: { ...usuario, lances } });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar usuario' });
  }
});

app.post('/api/pagamentos/gerar-pix', lanceLimiter, async (req, res) => {
  try {
    const { usuario_id, item_id, campanha_id, valor } = req.body;

    if (!usuario_id || !item_id || !campanha_id || !valor) {
      return res.status(400).json({ erro: 'Dados incompletos' });
    }

    const usuario = await db.buscarUsuarioPorId(usuario_id);
    const item = await db.buscarItemPorId(item_id);
    const campanha = await db.buscarCampanhaPorId(campanha_id);

    if (!usuario || !item || !campanha) {
      return res.status(404).json({ erro: 'Dados nao encontrados' });
    }

    if (campanha.status !== 'ativa') {
      return res.status(400).json({ erro: 'Campanha nao esta ativa' });
    }

    const lance = await db.criarLance({
      item_id,
      campanha_id,
      usuario_id,
      valor,
      status: 'pendente',
      ip_address: req.ip,
      user_agent: req.headers['user-agent']
    });

    const pagamento = await db.criarPagamento({
      lance_id: lance.id,
      usuario_id,
      item_id,
      campanha_id,
      valor,
      chave_pix: CHAVE_PIX
    });

    let qrCode = null;
    let qrCodeBase64 = null;
    let mpId = null;

    if (MP_ACCESS_TOKEN) {
      try {
        const mpResponse = await axios.post(
          'https://api.mercadopago.com/v1/payments',
          {
            transaction_amount: parseFloat(valor),
            description: `Lance ${item.nome} - ${campanha.nome}`,
            payment_method_id: 'pix',
            payer: {
              email: usuario.email || `usuario_${usuario.id}@leilaofacil.com`,
              first_name: usuario.nome.split(' ')[0],
              last_name: usuario.nome.split(' ').slice(1).join(' ') || 'Sobrenome'
            },
            notification_url: `${req.protocol}://${req.get('host')}/api/webhooks/mercado-pago`
          },
          {
            headers: {
              'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
              'Content-Type': 'application/json'
            }
          }
        );

        if (mpResponse.data && mpResponse.data.point_of_interaction) {
          qrCode = mpResponse.data.point_of_interaction.transaction_data.qr_code;
          qrCodeBase64 = mpResponse.data.point_of_interaction.transaction_data.qr_code_base64;
          mpId = mpResponse.data.id.toString();

          await db.atualizarStatusPagamento(pagamento.id, 'pendente', mpResponse.data.status);
        }
      } catch (mpErr) {
        console.error('Erro Mercado Pago:', mpErr.response?.data || mpErr.message);
        qrCode = gerarPayloadPIX(usuario.nome, valor, `Lance ${item.nome}`);
      }
    } else {
      qrCode = gerarPayloadPIX(usuario.nome, valor, `Lance ${item.nome}`);
    }

    res.json({
      sucesso: true,
      pagamento: {
        id: pagamento.id,
        valor,
        qrCode,
        qrCodeBase64,
        mpId,
        status: 'pendente'
      },
      lance: { id: lance.id, itemId, valor }
    });

  } catch (err) {
    console.error('Erro ao gerar PIX:', err);
    res.status(500).json({ erro: 'Erro ao gerar pagamento PIX' });
  }
});

app.post('/api/webhooks/mercado-pago', async (req, res) => {
  try {
    const { data, type } = req.body;

    if (type === 'payment' && data && data.id) {
      const mpId = data.id.toString();
      const pagamento = await db.buscarPagamentoPorMpId(mpId);

      if (pagamento) {
        const mpResponse = await axios.get(
          `https://api.mercadopago.com/v1/payments/${data.id}`,
          { headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` } }
        );

        const status = mpResponse.data.status;

        if (status === 'approved') {
          await db.atualizarStatusPagamento(pagamento.id, 'aprovado', status);

          const lance = await db.buscarLancePorId(pagamento.lance_id);
          if (lance) {
            await db.atualizarLance(lance.id, { status: 'confirmado' });
            await db.atualizarTotaisCampanha(pagamento.campanha_id);
            await db.atualizarGastosUsuario(pagamento.usuario_id);

            safeEmit('pagamento_confirmado', {
              lanceId: lance.id,
              pagamentoId: pagamento.id,
              valor: pagamento.valor
            });
          }
        } else if (['rejected', 'cancelled'].includes(status)) {
          await db.atualizarStatusPagamento(pagamento.id, 'rejeitado', status);
        }
      }
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Erro webhook:', err);
    res.status(200).send('OK');
  }
});

app.get('/api/pagamentos/:id', async (req, res) => {
  try {
    const pagamento = await db.buscarPagamentoPorId(req.params.id);
    if (!pagamento) {
      return res.status(404).json({ erro: 'Pagamento nao encontrado' });
    }
    res.json({ sucesso: true, pagamento });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao consultar pagamento' });
  }
});

app.get('/api/campanhas/:id/rankings', async (req, res) => {
  try {
    const campanhaId = req.params.id;
    const maiorLance = await db.buscarRankingMaiorLance(campanhaId);
    const maisLances = await db.buscarRankingLances(campanhaId);
    const menosLances = await db.buscarRankingMenorLance(campanhaId);

    res.json({
      sucesso: true,
      rankings: {
        maiorLance: maiorLance.slice(0, 10),
        maisLances: maisLances.slice(0, 10),
        menosLances: menosLances.slice(0, 10)
      }
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar rankings' });
  }
});

// ==========================================
// ROTAS ADMINISTRATIVAS
// ==========================================

app.post('/api/admin/login', loginLimiter, async (req, res) => {
  try {
    const { senha } = req.body;
    if (!senha) {
      return res.status(400).json({ erro: 'Senha obrigatoria' });
    }

    let valido = false;
    if (ADMIN_PASSWORD_HASH) {
      valido = await bcrypt.compare(senha, ADMIN_PASSWORD_HASH);
    } else if (ADMIN_PASSWORD_PLAIN) {
      valido = senha === ADMIN_PASSWORD_PLAIN;
    }

    if (!valido) {
      return res.status(401).json({ erro: 'Senha incorreta' });
    }

    const token = gerarTokenAdmin();
    res.json({ sucesso: true, token });
  } catch (err) {
    console.error('Erro login:', err);
    res.status(500).json({ erro: 'Erro ao autenticar' });
  }
});

app.get('/api/admin/verificar', verificarTokenAdmin, (req, res) => {
  res.json({ sucesso: true, admin: true });
});

app.get('/api/admin/dashboard', verificarTokenAdmin, async (req, res) => {
  try {
    console.log('[DEBUG] GET /api/admin/dashboard - iniciando');
    const stats = await db.getDashboardStats();
    console.log('[DEBUG] Dashboard stats:', JSON.stringify(stats));
    const campanhasRecentes = (await db.listarCampanhas()).slice(0, 5);
    const pagamentosPendentes = (await db.listarPagamentosPendentes()).slice(0, 10);

    res.json({
      sucesso: true,
      ...stats,
      campanhasRecentes,
      pagamentosPendentes
    });
  } catch (err) {
    console.error('[DEBUG] Erro dashboard:', err.message, err.stack);
    res.status(500).json({ erro: 'Erro ao carregar dashboard: ' + err.message });
  }
});

app.get('/api/admin/campanhas', verificarTokenAdmin, async (req, res) => {
  try {
    const campanhas = await db.listarCampanhas();
    res.json({ sucesso: true, campanhas });
  } catch (err) {
    console.error('Erro listar campanhas:', err);
    res.status(500).json({ erro: 'Erro ao listar campanhas' });
  }
});

app.post('/api/admin/campanhas', verificarTokenAdmin, async (req, res) => {
  try {
    const dados = req.body;
    console.log('[DEBUG] POST /api/admin/campanhas - headers:', JSON.stringify(req.headers['content-type']));
    console.log('[DEBUG] POST /api/admin/campanhas - body:', JSON.stringify(dados));

    if (!dados || Object.keys(dados).length === 0) {
      console.log('[DEBUG] Body vazio ou invalido');
      return res.status(400).json({ 
        erro: 'Body vazio. Verifique se esta enviando Content-Type: application/json',
        bodyRecebido: dados,
        headers: req.headers['content-type']
      });
    }

    if (!dados.nome || dados.nome.trim().length < 3) {
      console.log('[DEBUG] Nome invalido:', dados.nome);
      return res.status(400).json({ 
        erro: 'Nome da campanha e obrigatorio (minimo 3 caracteres)',
        bodyRecebido: dados 
      });
    }

    const slug = dados.slug || gerarSlug(dados.nome);
    const existente = await db.buscarCampanhaPorSlug(slug);
    if (existente) {
      return res.status(400).json({ erro: 'Ja existe uma campanha com este identificador' });
    }

    const campanhaData = {
      ...dados,
      slug,
      premio_imagem: dados.premio_imagem || null
    };

    const campanha = await db.criarCampanha(campanhaData);

    if (dados.itens && Array.isArray(dados.itens)) {
      for (const itemData of dados.itens) {
        await db.criarItem({ campanha_id: campanha.id, ...itemData });
      }
    }

    safeEmit('campanha_criada', { campanha });
    await db.registrarAtividade('campanha_criada', `Nova campanha "${campanha.nome}" criada`, { campanhaId: campanha.id });

    res.status(201).json({ sucesso: true, campanha });
  } catch (err) {
    console.error('Erro ao criar campanha:', err);
    res.status(500).json({ erro: 'Erro ao criar campanha' });
  }
});

app.get('/api/admin/campanhas/:id', verificarTokenAdmin, async (req, res) => {
  try {
    const stats = await db.getCampanhaStats(req.params.id);
    if (!stats) {
      return res.status(404).json({ erro: 'Campanha nao encontrada' });
    }
    res.json({ sucesso: true, campanha: stats });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar campanha' });
  }
});

app.put('/api/admin/campanhas/:id', verificarTokenAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const dados = req.body;

    if (dados.nome && !dados.slug) {
      const novoSlug = gerarSlug(dados.nome);
      const existente = await db.buscarCampanhaPorSlug(novoSlug);
      if (!existente || String(existente.id) === String(id)) {
        dados.slug = novoSlug;
      } else {
        dados.slug = novoSlug + '-' + Date.now();
      }
    }

    const campanha = await db.atualizarCampanhaCompleta(id, dados);
    if (!campanha) {
      return res.status(404).json({ erro: 'Campanha nao encontrada' });
    }

    safeEmit('campanha_atualizada', { campanha });
    await db.registrarAtividade('campanha_editada', `Campanha "${campanha.nome}" atualizada`, { campanhaId: id });

    res.json({ sucesso: true, campanha });
  } catch (err) {
    console.error('Erro ao atualizar campanha:', err);
    res.status(500).json({ erro: 'Erro ao atualizar campanha' });
  }
});

app.post('/api/admin/campanhas/:id/ativar', verificarTokenAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const campanha = await db.buscarCampanhaPorId(id);

    if (!campanha) {
      return res.status(404).json({ erro: 'Campanha nao encontrada' });
    }

    if (campanha.status === 'ativa') {
      return res.status(400).json({ erro: 'Campanha ja esta ativa' });
    }

    await db.ativarCampanha(id);
    iniciarTimerCampanha(id);

    const atualizada = await db.buscarCampanhaPorId(id);
    safeEmit('campanha_ativada', { campanhaId: id, campanha: atualizada });
    await db.registrarAtividade('campanha_ativada', `Campanha "${atualizada.nome}" ativada`, { campanhaId: id });

    res.json({ sucesso: true, campanha: atualizada });
  } catch (err) {
    console.error('Erro ao ativar campanha:', err);
    res.status(500).json({ erro: 'Erro ao ativar campanha' });
  }
});

app.post('/api/admin/campanhas/:id/pausar', verificarTokenAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    await db.pausarCampanha(id);
    cancelarTimerCampanha(id);

    safeEmit('campanha_pausada', { campanhaId: id });
    await db.registrarAtividade('campanha_pausada', `Campanha ${id} pausada`, { campanhaId: id });

    res.json({ sucesso: true });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao pausar campanha' });
  }
});

app.post('/api/admin/campanhas/:id/finalizar', verificarTokenAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    await finalizarCampanha(id);
    res.json({ sucesso: true });
  } catch (err) {
    console.error('Erro ao finalizar campanha:', err);
    res.status(500).json({ erro: 'Erro ao finalizar campanha' });
  }
});

app.post('/api/admin/campanhas/:id/resetar', verificarTokenAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    cancelarTimerCampanha(id);

    await db.atualizarCampanha(id, {
      status: 'pendente',
      total_arrecadado: 0,
      total_lances: 0,
      total_participantes: 0,
      data_inicio: null,
      data_fim: null
    });

    const itens = await db.listarItensPorCampanha(id);
    for (const item of itens) {
      await db.atualizarCampanha(item.id, {
        status: 'ativo',
        lance_atual: item.lance_inicial,
        vencedor_id: null,
        data_encerramento: null
      });
    }

    res.json({ sucesso: true });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao resetar campanha' });
  }
});

app.delete('/api/admin/campanhas/:id', verificarTokenAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    cancelarTimerCampanha(id);
    await db.atualizarCampanha(id, { status: 'cancelada' });

    res.json({ sucesso: true });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao deletar campanha' });
  }
});

app.get('/api/admin/campanhas/:id/exportar', verificarTokenAdmin, async (req, res) => {
  try {
    const campanhaId = req.params.id;
    const stats = await db.getCampanhaStats(campanhaId);

    if (!stats) {
      return res.status(404).json({ erro: 'Campanha nao encontrada' });
    }

    const csvHeader = 'ID,Nome,Email,Valor,Data\n';
    const csvRows = stats.lances.map(l =>
      `${l.id},"${l.usuario_nome}","${l.email || ''}",${l.valor},"${l.data_hora}"`
    ).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="campanha-${campanhaId}-${Date.now()}.csv"`);
    res.send(csvHeader + csvRows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao exportar dados' });
  }
});

app.get('/api/admin/usuarios', verificarTokenAdmin, async (req, res) => {
  try {
    const { limit = 100, offset = 0 } = req.query;
    const usuarios = await db.listarUsuarios(parseInt(limit), parseInt(offset));
    res.json({ sucesso: true, usuarios });
  } catch (err) {
    console.error('Erro listar usuarios:', err);
    res.status(500).json({ erro: 'Erro ao listar usuarios' });
  }
});

app.get('/api/admin/influencers', verificarTokenAdmin, async (req, res) => {
  try {
    const influencers = await db.listarInfluencers();
    res.json({ sucesso: true, influencers });
  } catch (err) {
    console.error('Erro listar influencers:', err);
    res.status(500).json({ erro: 'Erro ao listar influencers' });
  }
});

app.post('/api/admin/influencers', verificarTokenAdmin, async (req, res) => {
  try {
    const { nome, email, codigo_ref, comissao_percentual, pix_chave, premio_25, premio_50, premio_75, premio_100 } = req.body;

    if (!nome || !email || !codigo_ref) {
      return res.status(400).json({ erro: 'Nome, email e codigo de referencia sao obrigatorios' });
    }

    const influencer = await db.criarInfluencer({
      nome,
      email,
      codigo_ref,
      comissao_percentual: parseInt(comissao_percentual) || COMISSAO_PADRAO,
      pix_chave,
      premio_25: parseFloat(premio_25) || 0,
      premio_50: parseFloat(premio_50) || 0,
      premio_75: parseFloat(premio_75) || 0,
      premio_100: parseFloat(premio_100) || 0
    });

    safeEmit('influencer_criado', { influencer });
    res.status(201).json({ sucesso: true, influencer });
  } catch (err) {
    console.error('Erro criar influencer:', err);
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ erro: 'Codigo de referencia ou email ja existe' });
    }
    res.status(500).json({ erro: 'Erro ao criar influencer' });
  }
});

app.put('/api/admin/influencers/:id', verificarTokenAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const dados = req.body;

    const camposPermitidos = ['nome', 'email', 'codigo_ref', 'comissao_percentual', 'pix_chave', 'ativo', 'premio_25', 'premio_50', 'premio_75', 'premio_100'];
    const updateData = {};
    camposPermitidos.forEach(campo => {
      if (dados[campo] !== undefined) updateData[campo] = dados[campo];
    });

    const influencer = await db.atualizarInfluencer(id, updateData);
    if (!influencer) {
      return res.status(404).json({ erro: 'Influencer nao encontrado' });
    }

    safeEmit('influencer_atualizado', { influencer });
    res.json({ sucesso: true, influencer });
  } catch (err) {
    console.error('Erro ao atualizar influencer:', err);
    res.status(500).json({ erro: 'Erro ao atualizar influencer' });
  }
});

app.get('/api/admin/influencers/:id/milestones', verificarTokenAdmin, async (req, res) => {
  try {
    const milestones = await db.buscarMilestonesPorInfluencer(req.params.id);
    res.json({ sucesso: true, milestones });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar milestones' });
  }
});

app.get('/api/admin/configuracoes', verificarTokenAdmin, async (req, res) => {
  try {
    const configs = {
      lanceInicial: await db.getConfig('lance_inicial_padrao'),
      lanceMinimo: await db.getConfig('lance_minimo_padrao'),
      duracaoPadrao: await db.getConfig('duracao_padrao_horas'),
      comissaoPadrao: await db.getConfig('comissao_padrao'),
      siteNome: await db.getConfig('site_nome'),
      siteUrl: await db.getConfig('site_url')
    };
    res.json({ sucesso: true, configuracoes: configs });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar configuracoes' });
  }
});

app.put('/api/admin/configuracoes', verificarTokenAdmin, async (req, res) => {
  try {
    const configs = req.body;
    for (const [chave, valor] of Object.entries(configs)) {
      await db.setConfig(chave, valor);
    }

    await db.registrarAtividade('configuracoes_alteradas', 'Configuracoes padrao atualizadas. Novas campanhas usarao estes valores.', configs);

    safeEmit('configuracoes_atualizadas', { configs });
    res.json({ sucesso: true, aviso: 'Estas alteracoes so afetarao novas campanhas. Campanhas em andamento permanecem inalteradas.' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao salvar configuracoes' });
  }
});

app.get('/api/admin/atividades', verificarTokenAdmin, async (req, res) => {
  try {
    const atividades = await db.buscarAtividadesRecentes(50);
    res.json({ sucesso: true, atividades });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar atividades' });
  }
});

// ==========================================
// ROTAS DE INFLUENCER
// ==========================================
app.get('/api/influencers/:codigo', async (req, res) => {
  try {
    const influencer = await db.buscarInfluencerPorCodigo(req.params.codigo);
    if (!influencer) {
      return res.status(404).json({ erro: 'Influencer nao encontrado' });
    }

    const { pix_chave, ...publico } = influencer;
    res.json({ sucesso: true, influencer: publico });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar influencer' });
  }
});

// ==========================================
// ERROS E INICIALIZACAO
// ==========================================

app.use((err, req, res, next) => {
  console.error('Erro:', err);

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ erro: 'Arquivo muito grande. Maximo 5MB.' });
    }
    return res.status(400).json({ erro: 'Erro no upload do arquivo' });
  }

  res.status(500).json({ erro: 'Erro interno do servidor' });
});

app.use((req, res) => {
  res.status(404).json({ erro: 'Rota nao encontrada' });
});

server.listen(PORT, async () => {
  console.log('');
  console.log('LEILAO FACIL v2.1.3 - Servidor iniciado (DEBUG MODE)');
  console.log(`Database module: database-pg.js`);
  console.log(`Porta: ${PORT}`);
  console.log(`Ambiente: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Banco: ${process.env.DATABASE_URL ? 'PostgreSQL (Supabase)' : 'SQLite (local)'}`);
  console.log(`JWT: ${JWT_SECRET ? 'Configurado' : 'USANDO PADRAO (INSEGURO!)'}`);
  console.log(`PIX: ${MP_ACCESS_TOKEN ? 'Mercado Pago' : 'Estatico (sem token)'}`);
  console.log('');

  await verificarCampanhasAtivas();
});

module.exports = { app, server, io };

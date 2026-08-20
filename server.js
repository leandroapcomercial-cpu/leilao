const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config();

const db = require('./database-pg');
const app = express();
const PORT = process.env.PORT || 10000;

// ========== MIDDLEWARES ==========
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.socket.io", "https://cdnjs.cloudflare.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      connectSrc: ["'self'", "ws:", "wss:", "https://api.mercadopago.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
    }
  }
}));

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ========== SOCKET.IO ==========
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ['websocket', 'polling']
});

function safeEmit(evento, dados) {
  try { io.emit(evento, dados); } catch (e) { console.error('Socket emit erro:', e.message); }
}

io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);
  socket.on('disconnect', () => console.log('Cliente desconectado:', socket.id));
});

// ========== AUTH ADMIN ==========
const JWT_SECRET = process.env.JWT_SECRET || 'leilao-facil-secret-jwt-2026';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD_PLAIN || 'admin123';

function gerarTokenAdmin() {
  return jwt.sign({ tipo: 'admin', timestamp: Date.now() }, JWT_SECRET, { expiresIn: '8h' });
}

function verificarAdmin(req, res, next) {
  const auth = req.headers.authorization;
  console.log('[DEBUG] Auth header:', auth ? auth.substring(0, 30) + '...' : 'MISSING');
  if (!auth || !auth.startsWith('Bearer ')) {
    console.log('[DEBUG] 401 - Sem Bearer token');
    return res.status(401).json({ erro: 'Não autorizado - token ausente' });
  }
  try {
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    console.log('[DEBUG] Token decodificado:', decoded.tipo);
    if (decoded.tipo !== 'admin') {
      console.log('[DEBUG] 403 - Tipo não é admin:', decoded.tipo);
      return res.status(403).json({ erro: 'Acesso negado' });
    }
    next();
  } catch (err) {
    console.log('[DEBUG] 401 - Token inválido:', err.message);
    return res.status(401).json({ erro: 'Token inválido', detalhe: err.message });
  }
}

// ========== ROTA LOGIN ADMIN ==========
app.post('/api/admin/login', async (req, res) => {
  const { senha } = req.body;
  if (!senha) return res.status(400).json({ erro: 'Senha obrigatória' });
  if (senha !== ADMIN_PASSWORD) return res.status(401).json({ erro: 'Senha incorreta' });
  res.json({ sucesso: true, token: gerarTokenAdmin() });
});

// ========== ROTAS ADMIN - DASHBOARD ==========
app.get('/api/admin/dashboard', verificarAdmin, async (req, res) => {
  try {
    const stats = await db.getDashboardStats();
    res.json({ sucesso: true, ...stats });
  } catch (err) {
    console.error('[DEBUG] Erro dashboard:', err.message);
    res.status(500).json({ erro: 'Erro ao carregar dashboard', detalhe: err.message });
  }
});

// ========== ROTAS ADMIN - CAMPANHAS ==========
app.get('/api/admin/campanhas', verificarAdmin, async (req, res) => {
  try {
    const campanhas = await db.listarCampanhas();
    res.json({ sucesso: true, campanhas });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/admin/campanhas', verificarAdmin, async (req, res) => {
  try {
    const dados = req.body;
    if (!dados.nome) return res.status(400).json({ erro: 'Nome obrigatório' });

    // Gerar slug limpo
    let slug = dados.slug || gerarSlug(dados.nome);
    let slugOriginal = slug;
    let contador = 2;
    while (await db.slugExiste(slug)) {
      slug = `${slugOriginal}-${contador}`;
      contador++;
    }

    const camp = await db.criarCampanha({ ...dados, slug, status: 'pendente' });
    res.status(201).json({ sucesso: true, campanha: camp });
  } catch (err) {
    console.error('[DEBUG] Erro criar campanha:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.put('/api/admin/campanhas/:id', verificarAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const dados = req.body;

    // Se mudou nome e não definiu slug, regenerar
    if (dados.nome && !dados.slug) {
      let slug = gerarSlug(dados.nome);
      let slugOriginal = slug;
      let contador = 2;
      const existente = await db.buscarCampanhaPorId(id);
      while (await db.slugExiste(slug) && existente?.slug !== slug) {
        slug = `${slugOriginal}-${contador}`;
        contador++;
      }
      dados.slug = slug;
    }

    const camp = await db.atualizarCampanha(id, dados);
    res.json({ sucesso: true, campanha: camp });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.delete('/api/admin/campanhas/:id', verificarAdmin, async (req, res) => {
  try {
    await db.deletarCampanha(parseInt(req.params.id));
    res.json({ sucesso: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/admin/campanhas/:id/ativar', verificarAdmin, async (req, res) => {
  try {
    const camp = await db.ativarCampanha(parseInt(req.params.id));
    if (!camp) return res.status(404).json({ erro: 'Campanha não encontrada' });
    safeEmit('campanha_ativada', { id: camp.id, slug: camp.slug, nome: camp.nome });
    res.json({ sucesso: true, campanha: camp });
  } catch (err) {
    console.error('[DEBUG] Erro ativar:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/admin/campanhas/:id/pausar', verificarAdmin, async (req, res) => {
  try {
    const camp = await db.pausarCampanha(parseInt(req.params.id));
    if (!camp) return res.status(404).json({ erro: 'Campanha não encontrada' });
    safeEmit('campanha_pausada', { id: camp.id, slug: camp.slug });
    res.json({ sucesso: true, campanha: camp });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/admin/campanhas/:id/finalizar', verificarAdmin, async (req, res) => {
  try {
    const camp = await db.finalizarCampanha(parseInt(req.params.id));
    if (!camp) return res.status(404).json({ erro: 'Campanha não encontrada' });
    safeEmit('campanha_finalizada', { id: camp.id, slug: camp.slug });
    res.json({ sucesso: true, campanha: camp });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ========== ROTAS ADMIN - INFLUENCERS ==========
app.get('/api/admin/influencers', verificarAdmin, async (req, res) => {
  try {
    const influencers = await db.listarInfluencers();
    res.json({ sucesso: true, influencers });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/admin/influencers', verificarAdmin, async (req, res) => {
  try {
    const inf = await db.criarInfluencer(req.body);
    res.status(201).json({ sucesso: true, influencer: inf });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.put('/api/admin/influencers/:id', verificarAdmin, async (req, res) => {
  try {
    const inf = await db.atualizarInfluencer(parseInt(req.params.id), req.body);
    res.json({ sucesso: true, influencer: inf });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.delete('/api/admin/influencers/:id', verificarAdmin, async (req, res) => {
  try {
    await db.deletarInfluencer(parseInt(req.params.id));
    res.json({ sucesso: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ========== ROTAS ADMIN - USUÁRIOS ==========
app.get('/api/admin/usuarios', verificarAdmin, async (req, res) => {
  try {
    const usuarios = await db.listarUsuarios();
    res.json({ sucesso: true, usuarios });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ========== ROTAS ADMIN - CONFIGURAÇÕES ==========
app.get('/api/admin/configuracoes', verificarAdmin, async (req, res) => {
  try {
    const config = await db.buscarConfiguracoes();
    res.json({ sucesso: true, configuracoes: config });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.put('/api/admin/configuracoes', verificarAdmin, async (req, res) => {
  try {
    const config = await db.atualizarConfiguracoes(req.body);
    res.json({ sucesso: true, configuracoes: config });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ========== ROTAS PÚBLICAS - LEILÃO ==========
app.get('/api/campanha/:slug', async (req, res) => {
  try {
    const camp = await db.buscarCampanhaPorSlug(req.params.slug);
    if (!camp) return res.json({ item: null, campanha: null });

    const lances = await db.buscarLancesPorCampanha(camp.id, 10);
    const ultimoLance = await db.buscarUltimoLance(camp.id);
    const totalLances = await db.contarLancesPorCampanha(camp.id);
    const agora = new Date();
    const encerrado = camp.status === 'finalizado' || (camp.data_fim && new Date(camp.data_fim) < agora);
    const temLanceInicial = totalLances > 0;

    const lanceAtual = ultimoLance ? parseFloat(ultimoLance.valor) : 0;

    res.json({
      item: {
        id: camp.id,
        nome: camp.nome,
        descricao: camp.descricao || 'Participe e concorra!',
        premio_imagem: camp.premio_imagem || '🏆',
        premio_imagem_url: camp.premio_imagem_url || '',
        lance_atual: lanceAtual,
        total_lances: totalLances,
        ultimos_lances: lances.map(l => ({
          nome: l.usuario_nome,
          valor: parseFloat(l.valor),
          data: l.data_hora
        })),
        ultimo_lance: ultimoLance ? {
          usuario: ultimoLance.usuario_nome,
          valor: parseFloat(ultimoLance.valor),
          data: ultimoLance.data_hora
        } : null,
        data_fim: camp.data_fim,
        status: camp.status,
        encerrado: encerrado,
        tem_lance_inicial: temLanceInicial,
        started_at: camp.data_inicio
      },
      campanha: {
        nome: camp.nome,
        meta_valor: parseFloat(camp.meta_valor) || 3.00
      }
    });
  } catch (err) {
    console.error('[DEBUG] Erro campanha publica:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ========== ROTAS PÚBLICAS - USUÁRIO ==========
app.post('/api/usuario', async (req, res) => {
  try {
    const { nome, email } = req.body;
    if (!nome || !email) return res.status(400).json({ erro: 'Nome e email obrigatórios' });
    if (!email.includes('@')) return res.status(400).json({ erro: 'Email inválido' });

    const usuario = await db.buscarOuCriarUsuario(nome.trim(), email.trim().toLowerCase());
    res.json({ sucesso: true, usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email } });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ========== ROTAS PÚBLICAS - PAGAMENTO / PIX ==========
app.post('/api/criar-pagamento', async (req, res) => {
  try {
    const { item_id, campanha_id, usuario_id, nome, email, valor } = req.body;
    if (!item_id || !usuario_id || !valor) {
      return res.status(400).json({ erro: 'Dados incompletos' });
    }

    const camp = await db.buscarCampanhaPorId(item_id);
    if (!camp) return res.status(404).json({ erro: 'Campanha não encontrada' });
    if (camp.status !== 'ativo') return res.status(400).json({ erro: 'Leilão não está ativo' });

    const totalLances = await db.contarLancesPorCampanha(item_id);
    const isPrimeiroLance = totalLances === 0;

    // Simulação de pagamento (integrar Mercado Pago aqui se desejar)
    const transacaoId = `pix_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const pagamento = await db.criarPagamento({
      campanha_id: item_id,
      usuario_id,
      valor,
      status: 'pendente',
      mp_id: transacaoId,
      transacao_id: transacaoId,
      pix_qr_code: `00020126580014BR.GOV.BCB.PIX0136${email}5204000053039865404${(valor*100).toFixed(0)}5802BR5925${nome}6009SAO PAULO62070503***6304`,
      pix_qr_code_base64: '',
      pix_link: `https://pix.example.com/${transacaoId}`
    });

    res.json({
      sucesso: true,
      pagamento: {
        id: pagamento.id,
        valor: parseFloat(pagamento.valor),
        mp_id: pagamento.mp_id,
        transacao_id: pagamento.transacao_id,
        pix_qr_code: pagamento.pix_qr_code,
        pix_qr_code_base64: pagamento.pix_qr_code_base64,
        pix_link: pagamento.pix_link
      },
      is_primeiro_lance: isPrimeiroLance
    });
  } catch (err) {
    console.error('[DEBUG] Erro criar pagamento:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.get('/api/consultar-pagamento/:id', async (req, res) => {
  try {
    const pag = await db.buscarPagamentoPorTransacao(req.params.id);
    if (!pag) return res.status(404).json({ erro: 'Pagamento não encontrado' });
    res.json({
      status: pag.status,
      confirmado: pag.status === 'confirmado'
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/confirmar-pagamento', async (req, res) => {
  try {
    const { transacao_id } = req.body;
    if (!transacao_id) return res.status(400).json({ erro: 'transacao_id obrigatório' });

    const pag = await db.buscarPagamentoPorTransacao(transacao_id);
    if (!pag) return res.status(404).json({ erro: 'Pagamento não encontrado' });

    if (pag.status === 'confirmado') {
      return res.json({ sucesso: true, mensagem: 'Pagamento já confirmado' });
    }

    await db.atualizarPagamentoStatus(pag.id, 'confirmado');

    // Registrar lance
    const usuario = await db.buscarUsuarioPorId(pag.usuario_id);
    const camp = await db.buscarCampanhaPorId(pag.campanha_id);

    await db.registrarLance(pag.campanha_id, pag.usuario_id, usuario?.nome || 'Anônimo', pag.valor);

    // Se primeiro lance, ativar timer (se ainda não tiver data_fim)
    if (camp && !camp.data_inicio) {
      await db.ativarCampanha(camp.id);
    }

    safeEmit('novo_lance', {
      campanha_id: pag.campanha_id,
      usuario: usuario?.nome || 'Anônimo',
      valor: parseFloat(pag.valor)
    });

    safeEmit('pagamento_confirmado', {
      transacao_id: pag.transacao_id,
      mp_id: pag.mp_id,
      campanha_id: pag.campanha_id
    });

    res.json({ sucesso: true, mensagem: 'Pagamento confirmado e lance registrado' });
  } catch (err) {
    console.error('[DEBUG] Erro confirmar pagamento:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/gerar-qr', async (req, res) => {
  try {
    const { texto } = req.body;
    if (!texto) return res.status(400).json({ erro: 'Texto obrigatório' });

    // Gerar QR code simples em base64 (usando uma lib ou serviço externo seria ideal)
    // Aqui retornamos um placeholder; em produção, use qrcode lib
    const qrCode = Buffer.from(texto).toString('base64');
    res.json({ qr_code: qrCode });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ========== ROTAS PÚBLICAS - RANKING ==========
app.get('/api/ranking/:item_id', async (req, res) => {
  try {
    const id = parseInt(req.params.item_id);
    const [maior, mais, menos, lances] = await Promise.all([
      db.buscarRankingMaiorLance(id),
      db.buscarRankingMaisLances(id),
      db.buscarRankingMenosLances(id),
      db.buscarLancesPorCampanha(id, 100)
    ]);

    res.json({
      ranking_maior_lance: maior.map(r => ({ ...r, valor: parseFloat(r.valor), lances: parseInt(r.lances), total_investido: parseFloat(r.total_investido) })),
      ranking_mais_lances: mais.map(r => ({ ...r, valor: parseFloat(r.valor), lances: parseInt(r.lances), total_investido: parseFloat(r.total_investido) })),
      ranking_menos_lances: menos.map(r => ({ ...r, valor: parseFloat(r.valor), lances: parseInt(r.lances), total_investido: parseFloat(r.total_investido) })),
      lances: lances.map(l => ({ ...l, valor: parseFloat(l.valor), data_hora: l.data_hora }))
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ========== ROTA CATCH-ALL PARA SLUGS ==========
// Serve o index.html para qualquer rota que não seja API ou arquivo estático
app.get('/:slug', (req, res) => {
  const slug = req.params.slug;
  // Ignorar rotas conhecidas
  if (slug.startsWith('api') || slug.startsWith('admin') || slug.includes('.')) {
    return res.status(404).send('Not found');
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== UTILITÁRIOS ==========
function gerarSlug(nome) {
  return nome.toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ========== INICIALIZAÇÃO ==========
http.listen(PORT, () => {
  console.log(`LEILAO FACIL v2.2.0 - Servidor iniciado`);
  console.log(`Porta: ${PORT}`);
  console.log(`Ambiente: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Banco: PostgreSQL (Supabase)`);
  console.log(`PIX: Simulado (substituir por Mercado Pago em producao)`);
});

// Verificar campanhas ativas periodicamente
setInterval(async () => {
  try {
    const campanhas = await db.listarCampanhas();
    const agora = new Date();
    for (const camp of campanhas) {
      if (camp.status === 'ativo' && camp.data_fim && new Date(camp.data_fim) < agora) {
        await db.finalizarCampanha(camp.id);
        safeEmit('campanha_finalizada', { id: camp.id, slug: camp.slug });
        console.log(`Campanha ${camp.id} auto-finalizada`);
      }
    }
  } catch (e) { console.error('Erro verificacao campanhas:', e.message); }
}, 60000);

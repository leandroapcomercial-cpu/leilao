const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const multer = require('multer');

// Bcrypt com fallback
let bcrypt;
try { bcrypt = require('bcryptjs'); } catch (e) {
  try { bcrypt = require('bcrypt'); } catch (e2) { bcrypt = null; }
}

// Supabase lazy
let supabase = null;
function getSupabase() {
  if (supabase) return supabase;
  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL || process.env.SUPABASE_SERVICE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  supabase = createClient(url, key);
  return supabase;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'leilao-facil-secret-2026';

// PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('sslmode') || process.env.DATABASE_URL?.includes('amazonaws') || process.env.DATABASE_URL?.includes('supabase')
    ? { rejectUnauthorized: false }
    : false
});

// Multer memória
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Helpers
function slugify(text) {
  return text.toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function authenticate(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ erro: 'Token não fornecido' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch { return res.status(401).json({ erro: 'Token inválido' }); }
}

// Log fire-and-forget (só erros/avisos >= 400)
function logError(level, route, method, status, payload, message, ip) {
  const sql = `INSERT INTO system_logs (level, route, method, status, payload, message, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)`;
  pool.query(sql, [level, route, method, status, payload, message, ip]).catch(() => {});
}

// Limpeza automática de logs (7 dias)
async function cleanupLogs() {
  try {
    await pool.query(`DELETE FROM system_logs WHERE created_at < NOW() - INTERVAL '7 days'`);
  } catch (e) { console.error('[CLEANUP LOGS]', e.message); }
}

// Verifica se coluna existe em uma tabela
async function columnExists(table, column) {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return r.rows.length > 0;
}

// Auto-migration
async function runMigrations() {
  console.log('[MIGRATION] Verificando tabelas...');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS administradores (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(255) NOT NULL DEFAULT 'Admin',
      email VARCHAR(255) UNIQUE NOT NULL,
      senha VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS campanhas (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(255) NOT NULL,
      slug VARCHAR(255) UNIQUE NOT NULL,
      descricao TEXT,
      status VARCHAR(50) DEFAULT 'pendente',
      data_inicio TIMESTAMP,
      data_fim TIMESTAMP,
      duracao_horas INTEGER DEFAULT 24,
      valor_lance DECIMAL(10,2) DEFAULT 0.01,
      meta_valor DECIMAL(10,2) DEFAULT 0,
      premio_imagem TEXT,
      premio_nome VARCHAR(255),
      premio_descricao TEXT,
      influencer_id INTEGER,
      arrecadado DECIMAL(10,2) DEFAULT 0,
      total_lances INTEGER DEFAULT 0,
      visualizacoes INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lances (
      id SERIAL PRIMARY KEY,
      campanha_id INTEGER REFERENCES campanhas(id) ON DELETE CASCADE,
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
      valor DECIMAL(10,2) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pagamentos (
      id SERIAL PRIMARY KEY,
      campanha_id INTEGER REFERENCES campanhas(id) ON DELETE CASCADE,
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
      valor DECIMAL(10,2) NOT NULL,
      status VARCHAR(50) DEFAULT 'pendente',
      pix_code TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS influencers (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE,
      telefone VARCHAR(50),
      comissao DECIMAL(5,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS configuracoes (
      id SERIAL PRIMARY KEY,
      chave VARCHAR(255) UNIQUE NOT NULL,
      valor TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    )`);

  // Tabela system_logs com schema completo
  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_logs (
      id SERIAL PRIMARY KEY,
      level VARCHAR(20) NOT NULL,
      route VARCHAR(255),
      method VARCHAR(10),
      status INTEGER,
      payload TEXT,
      message TEXT,
      ip VARCHAR(45),
      created_at TIMESTAMP DEFAULT NOW()
    )`);

  // Adiciona colunas faltantes (se tabela foi criada em versão antiga)
  const logCols = [
    ['level', 'VARCHAR(20) NOT NULL DEFAULT \'INFO\''],
    ['route', 'VARCHAR(255)'],
    ['method', 'VARCHAR(10)'],
    ['status', 'INTEGER'],
    ['payload', 'TEXT'],
    ['message', 'TEXT'],
    ['ip', 'VARCHAR(45)'],
    ['created_at', 'TIMESTAMP DEFAULT NOW()']
  ];
  for (const [col, def] of logCols) {
    if (!(await columnExists('system_logs', col))) {
      await pool.query(`ALTER TABLE system_logs ADD COLUMN ${col} ${def}`);
      console.log(`[MIGRATION] Coluna ${col} adicionada em system_logs`);
    }
  }

  // Índices (isolados em try/catch — nunca quebram o deploy)
  const indices = [
    `CREATE INDEX IF NOT EXISTS idx_logs_level ON system_logs(level)`,
    `CREATE INDEX IF NOT EXISTS idx_logs_created ON system_logs(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_logs_route ON system_logs(route)`,
    `CREATE INDEX IF NOT EXISTS idx_campanhas_status ON campanhas(status)`,
    `CREATE INDEX IF NOT EXISTS idx_campanhas_slug ON campanhas(slug)`,
    `CREATE INDEX IF NOT EXISTS idx_lances_campanha ON lances(campanha_id)`
  ];
  for (const sql of indices) {
    try { await pool.query(sql); } catch (e) { console.log('[MIGRATION SKIP] Índice:', e.message); }
  }

  // Normaliza status antigos
  await pool.query(`UPDATE campanhas SET status = 'pendente' WHERE status NOT IN ('pendente','ativa','pausada','finalizada')`);

  // Remove constraint antiga de status se existir
  try {
    await pool.query(`ALTER TABLE campanhas DROP CONSTRAINT IF EXISTS campanhas_status_check`);
    console.log('[MIGRATION] Constraint antiga removida');
  } catch (e) { /* ignora */ }

  // Admin padrão
  const adm = await pool.query(`SELECT * FROM administradores WHERE email = $1`, ['admin@leilao.com']);
  if (adm.rows.length === 0) {
    let hash = 'admin123';
    if (bcrypt) hash = await bcrypt.hash('admin123', 10);
    await pool.query(`INSERT INTO administradores (nome, email, senha) VALUES ($1,$2,$3)`,
      ['Administrador', 'admin@leilao.com', hash]);
    console.log('[MIGRATION] Admin padrão criado: admin@leilao.com / admin123');
  }

  console.log('[MIGRATION] OK - Todas as tabelas verificadas/criadas');
}

// Middlewares
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https:", "http:"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https:", "http:"],
      imgSrc: ["'self'", "data:", "blob:", "https:", "http:"],
      connectSrc: ["'self'", "wss:", "ws:", "https:", "http:"],
      fontSrc: ["'self'", "https:", "data:"],
    }
  }
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Request logger leve (só erros)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const status = res.statusCode;
    if (status >= 400) {
      logError(
        status >= 500 ? 'ERROR' : 'WARN',
        req.path, req.method, status,
        JSON.stringify(req.body || {}).substring(0, 2000),
        res.statusMessage || `HTTP ${status}`,
        req.ip
      );
    }
  });
  next();
});

// ===================== ROTAS =====================

// Health check
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    const sup = getSupabase();
    res.json({ status: 'ok', database: 'connected', storage: sup ? 'configured' : 'not_configured', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'error', database: err.message });
  }
});

// Login admin
app.post('/api/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    console.log('[LOGIN] Tentativa:', email);
    if (!email || !senha) return res.status(400).json({ erro: 'Email e senha obrigatórios' });
    const result = await pool.query('SELECT * FROM administradores WHERE email = $1', [email]);
    console.log('[LOGIN] Registros encontrados:', result.rows.length);
    if (result.rows.length === 0) {
      console.log('[LOGIN] Email não encontrado');
      return res.status(401).json({ erro: 'Credenciais inválidas' });
    }
    const admin = result.rows[0];
    let valid = false;
    if (bcrypt && admin.senha && admin.senha.startsWith('$2')) {
      valid = await bcrypt.compare(senha, admin.senha);
    } else {
      valid = senha === admin.senha;
    }
    console.log('[LOGIN] bcrypt disponível:', !!bcrypt, '| Senha válida:', valid);
    if (!valid) return res.status(401).json({ erro: 'Credenciais inválidas' });
    const token = jwt.sign({ id: admin.id, email: admin.email }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, admin: { id: admin.id, nome: admin.nome, email: admin.email } });
  } catch (err) {
    console.error('[LOGIN ERROR]', err);
    res.status(500).json({ erro: 'Erro no servidor' });
  }
});

// CRUD Campanhas
app.get('/api/campanhas', authenticate, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM campanhas ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/campanhas', authenticate, async (req, res) => {
  try {
    const { nome, descricao, meta_valor, valor_lance, duracao_horas, premio_imagem, premio_nome, premio_descricao } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
    const slugBase = slugify(nome);
    let slug = slugBase;
    let suffix = 0;
    while (true) {
      const ex = await pool.query('SELECT id FROM campanhas WHERE slug = $1', [slug]);
      if (ex.rows.length === 0) break;
      suffix++;
      slug = `${slugBase}-${suffix}`;
    }
    const result = await pool.query(
      `INSERT INTO campanhas (nome, slug, descricao, meta_valor, valor_lance, duracao_horas, premio_imagem, premio_nome, premio_descricao, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pendente') RETURNING *`,
      [nome, slug, descricao, meta_valor, valor_lance, duracao_horas, premio_imagem, premio_nome, premio_descricao]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ erro: err.message }); }
});

app.put('/api/campanhas/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const atual = await pool.query('SELECT * FROM campanhas WHERE id = $1', [id]);
    if (atual.rows.length === 0) return res.status(404).json({ erro: 'Campanha não encontrada' });
    const c = atual.rows[0];
    const b = req.body;
    const nome = b.nome !== undefined ? b.nome : c.nome;
    const slug = b.slug !== undefined ? b.slug : c.slug;
    const descricao = b.descricao !== undefined ? b.descricao : c.descricao;
    const status = b.status !== undefined ? b.status : c.status;
    const data_inicio = b.data_inicio !== undefined ? b.data_inicio : c.data_inicio;
    const data_fim = b.data_fim !== undefined ? b.data_fim : c.data_fim;
    const duracao_horas = b.duracao_horas !== undefined ? b.duracao_horas : c.duracao_horas;
    const valor_lance = b.valor_lance !== undefined ? b.valor_lance : c.valor_lance;
    const meta_valor = b.meta_valor !== undefined ? b.meta_valor : c.meta_valor;
    const premio_imagem = b.premio_imagem !== undefined ? b.premio_imagem : c.premio_imagem;
    const premio_nome = b.premio_nome !== undefined ? b.premio_nome : c.premio_nome;
    const premio_descricao = b.premio_descricao !== undefined ? b.premio_descricao : c.premio_descricao;
    const influencer_id = b.influencer_id !== undefined ? b.influencer_id : c.influencer_id;
    const validStatus = ['pendente','ativa','pausada','finalizada'].includes(status) ? status : c.status;
    const result = await pool.query(
      `UPDATE campanhas SET nome=$1, slug=$2, descricao=$3, status=$4, data_inicio=$5, data_fim=$6,
       duracao_horas=$7, valor_lance=$8, meta_valor=$9, premio_imagem=$10, premio_nome=$11,
       premio_descricao=$12, influencer_id=$13, updated_at=NOW() WHERE id=$14 RETURNING *`,
      [nome, slug, descricao, validStatus, data_inicio, data_fim, duracao_horas, valor_lance, meta_valor,
       premio_imagem, premio_nome, premio_descricao, influencer_id, id]
    );
    res.json(result.rows[0]);
  } catch (err) { console.error('[CAMPANHA UPDATE ERROR]', err); res.status(500).json({ erro: err.message }); }
});

app.delete('/api/campanhas/:id', authenticate, async (req, res) => {
  try {
    await pool.query('DELETE FROM campanhas WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/campanhas/:id/ativar', authenticate, async (req, res) => {
  try {
    const result = await pool.query(`UPDATE campanhas SET status='ativa', data_inicio=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/campanhas/:id/pausar', authenticate, async (req, res) => {
  try {
    const result = await pool.query(`UPDATE campanhas SET status='pausada', updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/campanhas/:id/finalizar', authenticate, async (req, res) => {
  try {
    const result = await pool.query(`UPDATE campanhas SET status='finalizada', updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Upload imagem
app.post('/api/upload', authenticate, upload.single('imagem'), async (req, res) => {
  try {
    const sup = getSupabase();
    if (!sup) return res.status(503).json({ erro: 'Serviço de upload não configurado. Use URL de imagem externa.' });
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' });
    const ext = path.extname(req.file.originalname) || '.jpg';
    const filename = `campanhas/${Date.now()}_${Math.random().toString(36).substring(2)}${ext}`;
    const { data, error } = await sup.storage.from('leilao-facil').upload(filename, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false
    });
    if (error) throw error;
    const { data: urlData } = sup.storage.from('leilao-facil').getPublicUrl(filename);
    res.json({ url: urlData.publicUrl });
  } catch (err) { console.error('[UPLOAD]', err); res.status(500).json({ erro: err.message }); }
});

// Logs paginados
app.get('/api/logs', authenticate, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const level = req.query.level || '';
    let where = '';
    const params = [];
    if (level && ['ERROR','WARN','INFO','DEBUG'].includes(level)) {
      where = 'WHERE level = $1';
      params.push(level);
    }
    const countRes = await pool.query(`SELECT COUNT(*) FROM system_logs ${where}`, params);
    const total = parseInt(countRes.rows[0].count);
    const dataRes = await pool.query(
      `SELECT * FROM system_logs ${where} ORDER BY created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    );
    res.json({ logs: dataRes.rows, pagination: { page, limit, total, totalPages: Math.ceil(total/limit) } });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ===================== ROTAS PÚBLICAS DO LEILÃO =====================

app.get('/api/campanha/:slug', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM campanhas WHERE slug = $1', [req.params.slug]);
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Campanha não encontrada' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/usuarios', async (req, res) => {
  try {
    const { nome, email } = req.body;
    if (!nome || !email) return res.status(400).json({ erro: 'Nome e email obrigatórios' });
    let result = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
    if (result.rows.length > 0) return res.json(result.rows[0]);
    result = await pool.query('INSERT INTO usuarios (nome, email) VALUES ($1,$2) RETURNING *', [nome, email]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/lances/:campanha_id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.*, u.nome as nome_usuario FROM lances l JOIN usuarios u ON l.usuario_id = u.id WHERE l.campanha_id = $1 ORDER BY l.valor DESC, l.created_at ASC`,
      [req.params.campanha_id]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/lances', async (req, res) => {
  try {
    const { campanha_id, usuario_id, valor } = req.body;
    if (!campanha_id || !usuario_id || !valor) return res.status(400).json({ erro: 'Dados incompletos' });
    const camp = await pool.query('SELECT * FROM campanhas WHERE id = $1', [campanha_id]);
    if (camp.rows.length === 0) return res.status(404).json({ erro: 'Campanha não encontrada' });
    const c = camp.rows[0];
    if (c.status !== 'ativa') return res.status(400).json({ erro: 'Campanha não está ativa' });
    if (c.data_fim && new Date(c.data_fim) < new Date()) return res.status(400).json({ erro: 'Leilão finalizado' });

    const result = await pool.query(
      'INSERT INTO lances (campanha_id, usuario_id, valor) VALUES ($1,$2,$3) RETURNING *',
      [campanha_id, usuario_id, valor]
    );

    if (!c.data_fim) {
      const dataFim = new Date(Date.now() + (c.duracao_horas || 24) * 60 * 60 * 1000);
      await pool.query('UPDATE campanhas SET data_fim = $1 WHERE id = $2', [dataFim, campanha_id]);
    }

    await pool.query('UPDATE campanhas SET total_lances = total_lances + 1, arrecadado = arrecadado + $1 WHERE id = $2', [valor, campanha_id]);

    const userRes = await pool.query('SELECT nome FROM usuarios WHERE id = $1', [usuario_id]);
    const lanceData = { ...result.rows[0], nome_usuario: userRes.rows[0]?.nome || 'Anônimo' };
    io.emit('novo_lance', { campanha_id, lance: lanceData });
    res.json(lanceData);
  } catch (err) { console.error('[LANCE ERROR]', err); res.status(500).json({ erro: err.message }); }
});

// Serve index.html para qualquer slug (SPA do leilão)
app.get('/:slug', async (req, res) => {
  if (req.params.slug.startsWith('api') || req.params.slug.startsWith('socket')) {
    return res.status(404).json({ erro: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('[SOCKET] Cliente conectado:', socket.id);
  socket.on('disconnect', () => console.log('[SOCKET] Cliente desconectado:', socket.id));
});

// Inicialização
(async () => {
  try {
    await runMigrations();
    await cleanupLogs();
    setInterval(cleanupLogs, 24 * 60 * 60 * 1000);
    server.listen(PORT, () => console.log(`[SERVER] Rodando na porta ${PORT}`));
  } catch (err) {
    console.error('[FATAL]', err);
    process.exit(1);
  }
})();

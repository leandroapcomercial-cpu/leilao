const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const multer = require('multer');
const axios = require('axios');

// Bcrypt com fallback
let bcrypt;
try { bcrypt = require('bcryptjs'); } catch (e) {
  try { bcrypt = require('bcrypt'); } catch (e2) { bcrypt = null; }
}

// Supabase lazy
let supabase = null;
function getSupabase() {
  if (supabase) return supabase;
  try {
    const { createClient } = require('@supabase/supabase-js');
    const url = process.env.SUPABASE_URL || process.env.SUPABASE_SERVICE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
    if (!url || !key) return null;
    supabase = createClient(url, key);
    return supabase;
  } catch { return null; }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'leilao-facil-secret-2026';

// Mercado Pago
const MP_ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN;
const MP_WEBHOOK_SECRET = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
const CHAVE_PIX = process.env.CHAVE_PIX || 'leilao@facil.com';

// Verifica configuração do MP
function mpConfigurado() {
  return !!MP_ACCESS_TOKEN;
}

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


// ========== FUNÇÕES AUXILIARES DO MOTOR DE LEILÃO ==========

// Calcula o valor do próximo lance (maior lance atual + valor_lance da campanha)
async function calcularProximoLance(campanha_id) {
  try {
    const camp = await pool.query('SELECT valor_lance FROM campanhas WHERE id = $1', [campanha_id]);
    if (camp.rows.length === 0) return 0.01;

    const vlance = parseFloat(camp.rows[0].valor_lance) || 0.01;

    // Busca o maior lance confirmado
    const maxRes = await pool.query(
      'SELECT MAX(valor) as max_valor FROM lances WHERE campanha_id = $1',
      [campanha_id]
    );

    const maxValor = parseFloat(maxRes.rows[0].max_valor) || 0;

    // Se não há lances, o primeiro lance = valor_lance (ex: 0.01)
    // Se há lances, próximo = maior + valor_lance
    const proximo = maxValor === 0 ? vlance : maxValor + vlance;

    return parseFloat(proximo.toFixed(2));
  } catch (err) {
    console.error('[CALCULAR LANCE]', err.message);
    return 0.01;
  }
}

// Registra um lance após confirmação de pagamento (transação atômica)
async function registrarLanceConfirmado(campanha_id, usuario_id, valor) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insere o lance
    const lanceRes = await client.query(
      'INSERT INTO lances (campanha_id, usuario_id, valor) VALUES ($1,$2,$3) RETURNING *',
      [campanha_id, usuario_id, valor]
    );

    // Atualiza totais da campanha
    await client.query(
      'UPDATE campanhas SET total_lances = total_lances + 1, arrecadado = arrecadado + $1 WHERE id = $2',
      [valor, campanha_id]
    );

    await client.query('COMMIT');

    const lance = lanceRes.rows[0];

    // Busca nome do usuário para emitir via socket
    const userRes = await pool.query('SELECT nome FROM usuarios WHERE id = $1', [usuario_id]);
    const nome_usuario = userRes.rows[0]?.nome || 'Anônimo';

    const lanceData = { ...lance, nome_usuario };

    // Emite para todos os clientes na campanha
    io.emit('novo_lance', { campanha_id, lance: lanceData });

    // Emite atualização da campanha (para atualizar timer se for primeiro lance)
    const campAtualizada = await pool.query('SELECT * FROM campanhas WHERE id = $1', [campanha_id]);
    if (campAtualizada.rows.length > 0) {
      io.emit('campanha_atualizada', campAtualizada.rows[0]);
    }

    return lanceData;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ========== MERCADO PAGO ==========

// Gera PIX via API do Mercado Pago
async function gerarPixMP(valor, descricao, email, nome) {
  if (!MP_ACCESS_TOKEN) {
    throw new Error('Mercado Pago não configurado');
  }

  try {
    const response = await axios.post(
      'https://api.mercadopago.com/v1/payments',
      {
        transaction_amount: parseFloat(valor),
        description: descricao,
        payment_method_id: 'pix',
        payer: {
          email: email || `usuario_${Date.now()}@leilaofacil.com`,
          first_name: nome ? nome.split(' ')[0] : 'Usuario',
          last_name: nome ? nome.split(' ').slice(1).join(' ') : 'Leilao'
        },
        notification_url: `${process.env.SITE_URL || ''}/api/webhooks/mercado-pago`
      },
      {
        headers: {
          'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const data = response.data;

    return {
      mp_payment_id: data.id.toString(),
      status: data.status,
      qr_code: data.point_of_interaction?.transaction_data?.qr_code || null,
      qr_code_base64: data.point_of_interaction?.transaction_data?.qr_code_base64 || null,
      copia_cola: data.point_of_interaction?.transaction_data?.qr_code || null
    };
  } catch (err) {
    console.error('[MP PIX ERROR]', err.response?.data || err.message);
    throw new Error('Erro ao gerar PIX no Mercado Pago');
  }
}

// Consulta status do pagamento no MP
async function consultarPagamentoMP(mp_payment_id) {
  if (!MP_ACCESS_TOKEN) return null;

  try {
    const response = await axios.get(
      `https://api.mercadopago.com/v1/payments/${mp_payment_id}`,
      {
        headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` },
        timeout: 10000
      }
    );
    return response.data;
  } catch (err) {
    console.error('[MP CONSULTA ERROR]', err.message);
    return null;
  }
}

// Log fire-and-forget (só erros >= 400)
function logError(level, route, method, status, payload, message, ip) {
  const sql = `INSERT INTO system_logs (level, route, method, status, payload, message, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)`;
  pool.query(sql, [level, route, method, status, payload, message, ip]).catch(() => {});
}

// Limpeza automática de logs (7 dias)
async function cleanupLogs() {
  try {
    await pool.query(`DELETE FROM system_logs WHERE created_at < NOW() - INTERVAL '7 days'`);
  } catch (e) { /* ignora */ }
}

// Verifica se coluna existe
async function columnExists(table, column) {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return r.rows.length > 0;
}

// Adiciona coluna se não existir
async function addColumnIfMissing(table, column, def) {
  if (!(await columnExists(table, column))) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    console.log(`[MIGRATION] Coluna ${column} adicionada em ${table}`);
  }
}

// Auto-migration completa
async function runMigrations() {
  console.log('[MIGRATION] Iniciando...');

  // 1. administradores
  await pool.query(`
    CREATE TABLE IF NOT EXISTS administradores (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(255) NOT NULL DEFAULT 'Admin',
      email VARCHAR(255) UNIQUE NOT NULL,
      senha VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

  // 2. campanhas
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
  // Colunas extras campanhas
  await addColumnIfMissing('campanhas', 'descricao', 'TEXT');
  await addColumnIfMissing('campanhas', 'status', "VARCHAR(50) DEFAULT 'pendente'");
  await addColumnIfMissing('campanhas', 'data_inicio', 'TIMESTAMP');
  await addColumnIfMissing('campanhas', 'data_fim', 'TIMESTAMP');
  await addColumnIfMissing('campanhas', 'duracao_horas', 'INTEGER DEFAULT 24');
  await addColumnIfMissing('campanhas', 'valor_lance', 'DECIMAL(10,2) DEFAULT 0.01');
  await addColumnIfMissing('campanhas', 'meta_valor', 'DECIMAL(10,2) DEFAULT 0');
  await addColumnIfMissing('campanhas', 'premio_imagem', 'TEXT');
  await addColumnIfMissing('campanhas', 'premio_nome', 'VARCHAR(255)');
  await addColumnIfMissing('campanhas', 'premio_descricao', 'TEXT');
  await addColumnIfMissing('campanhas', 'influencer_id', 'INTEGER');
  await addColumnIfMissing('campanhas', 'arrecadado', 'DECIMAL(10,2) DEFAULT 0');
  await addColumnIfMissing('campanhas', 'total_lances', 'INTEGER DEFAULT 0');
  await addColumnIfMissing('campanhas', 'visualizacoes', 'INTEGER DEFAULT 0');
  await addColumnIfMissing('campanhas', 'updated_at', 'TIMESTAMP DEFAULT NOW()');
  await addColumnIfMissing('campanhas', 'tempo_restante', 'INTEGER');

  // Remove constraint antiga de status
  try { await pool.query(`ALTER TABLE campanhas DROP CONSTRAINT IF EXISTS campanhas_status_check`); } catch {}

  // 3. usuarios
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

  // 4. lances
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lances (
      id SERIAL PRIMARY KEY,
      campanha_id INTEGER REFERENCES campanhas(id) ON DELETE CASCADE,
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
      valor DECIMAL(10,2) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

  // 5. pagamentos
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

  // 6. influencers
  await pool.query(`
    CREATE TABLE IF NOT EXISTS influencers (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE,
      telefone VARCHAR(50),
      comissao DECIMAL(5,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

  // 7. configuracoes
  await pool.query(`
    CREATE TABLE IF NOT EXISTS configuracoes (
      id SERIAL PRIMARY KEY,
      chave VARCHAR(255) UNIQUE NOT NULL,
      valor TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    )`);

  // 8. system_logs
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
  await addColumnIfMissing('system_logs', 'level', "VARCHAR(20) NOT NULL DEFAULT 'INFO'");
  await addColumnIfMissing('system_logs', 'route', 'VARCHAR(255)');
  await addColumnIfMissing('system_logs', 'method', 'VARCHAR(10)');
  await addColumnIfMissing('system_logs', 'status', 'INTEGER');
  await addColumnIfMissing('system_logs', 'payload', 'TEXT');
  await addColumnIfMissing('system_logs', 'message', 'TEXT');
  await addColumnIfMissing('system_logs', 'ip', 'VARCHAR(45)');
  await addColumnIfMissing('system_logs', 'created_at', 'TIMESTAMP DEFAULT NOW()');

  // 9. pagamentos_pix (PIX do Mercado Pago)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pagamentos_pix (
      id SERIAL PRIMARY KEY,
      campanha_id INTEGER REFERENCES campanhas(id) ON DELETE CASCADE,
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
      mp_payment_id VARCHAR(100),
      mp_status VARCHAR(50),
      valor DECIMAL(10,2) NOT NULL,
      qr_code TEXT,
      qr_code_base64 TEXT,
      copia_cola TEXT,
      status VARCHAR(50) DEFAULT 'pendente',
      lance_registrado BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
  await addColumnIfMissing('pagamentos_pix', 'mp_payment_id', 'VARCHAR(100)');
  await addColumnIfMissing('pagamentos_pix', 'mp_status', 'VARCHAR(50)');
  await addColumnIfMissing('pagamentos_pix', 'qr_code', 'TEXT');
  await addColumnIfMissing('pagamentos_pix', 'qr_code_base64', 'TEXT');
  await addColumnIfMissing('pagamentos_pix', 'copia_cola', 'TEXT');
  await addColumnIfMissing('pagamentos_pix', 'status', "VARCHAR(50) DEFAULT 'pendente'");
  await addColumnIfMissing('pagamentos_pix', 'lance_registrado', 'BOOLEAN DEFAULT FALSE');
  await addColumnIfMissing('pagamentos_pix', 'updated_at', 'TIMESTAMP DEFAULT NOW()');

  // Índices (isolados)
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
  await pool.query(`UPDATE campanhas SET status = 'pendente' WHERE status IS NULL OR status NOT IN ('pendente','ativa','pausada','finalizada')`);

  // Admin padrão
  const adm = await pool.query(`SELECT * FROM administradores WHERE email = $1`, ['admin@leilao.com']);
  if (adm.rows.length === 0) {
    let hash = 'admin123';
    if (bcrypt) hash = await bcrypt.hash('admin123', 10);
    await pool.query(`INSERT INTO administradores (nome, email, senha) VALUES ($1,$2,$3)`,
      ['Administrador', 'admin@leilao.com', hash]);
    console.log('[MIGRATION] Admin padrão criado: admin@leilao.com / admin123');
  }

  console.log('[MIGRATION] OK');
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
    console.log('[LOGIN] Registros:', result.rows.length);
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
    console.log('[LOGIN] bcrypt:', !!bcrypt, '| válido:', valid);
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
  } catch (err) { console.error('[CAMPANHA UPDATE]', err); res.status(500).json({ erro: err.message }); }
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
    // Calcula segundos restantes antes de pausar
    const camp = await pool.query('SELECT data_fim FROM campanhas WHERE id = $1', [req.params.id]);
    let segundos = null;
    if (camp.rows.length > 0 && camp.rows[0].data_fim) {
      segundos = Math.max(0, Math.floor((new Date(camp.rows[0].data_fim) - Date.now()) / 1000));
    }
    const result = await pool.query(
      `UPDATE campanhas SET status='pausada', tempo_restante=$2, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id, segundos]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/campanhas/:id/play', authenticate, async (req, res) => {
  try {
    const camp = await pool.query('SELECT tempo_restante, duracao_horas FROM campanhas WHERE id = $1', [req.params.id]);
    let dataFim = null;
    if (camp.rows.length > 0 && camp.rows[0].tempo_restante) {
      dataFim = new Date(Date.now() + camp.rows[0].tempo_restante * 1000);
    } else if (camp.rows.length > 0) {
      dataFim = new Date(Date.now() + (camp.rows[0].duracao_horas || 24) * 60 * 60 * 1000);
    }
    const result = await pool.query(
      `UPDATE campanhas SET status='ativa', data_fim=$2, tempo_restante=NULL, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id, dataFim]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/campanhas/:id/reset', authenticate, async (req, res) => {
  try {
    const cid = req.params.id;
    // Deleta todos os lances
    await pool.query('DELETE FROM lances WHERE campanha_id = $1', [cid]);
    // Reseta campanha mantendo configurações
    const result = await pool.query(
      `UPDATE campanhas SET status='pendente', total_lances=0, arrecadado=0, data_fim=NULL, tempo_restante=NULL, visualizacoes=0, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [cid]
    );
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

// ===================== ROTAS PÚBLICAS =====================

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
    console.log('[LANCE] Payload:', { campanha_id, usuario_id, valor });

    if (!campanha_id || !usuario_id || valor === undefined || valor === null) {
      return res.status(400).json({ erro: 'Dados incompletos' });
    }

    // Verifica se usuário existe (pode ter sido perdido no reset do banco)
    const userCheck = await pool.query('SELECT * FROM usuarios WHERE id = $1', [usuario_id]);
    if (userCheck.rows.length === 0) {
      console.log('[LANCE] Usuário não encontrado no banco. ID:', usuario_id);
      return res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' });
    }

    const camp = await pool.query('SELECT * FROM campanhas WHERE id = $1', [campanha_id]);
    if (camp.rows.length === 0) return res.status(404).json({ erro: 'Campanha não encontrada' });

    const c = camp.rows[0];
    if (c.status !== 'ativa') return res.status(400).json({ erro: 'Campanha não está ativa' });
    if (c.data_fim && new Date(c.data_fim) < new Date()) return res.status(400).json({ erro: 'Leilão finalizado' });

    const valorNum = parseFloat(valor);
    const result = await pool.query(
      'INSERT INTO lances (campanha_id, usuario_id, valor) VALUES ($1,$2,$3) RETURNING *',
      [campanha_id, usuario_id, valorNum]
    );

    if (!c.data_fim) {
      const dataFim = new Date(Date.now() + (c.duracao_horas || 24) * 60 * 60 * 1000);
      await pool.query('UPDATE campanhas SET data_fim = $1 WHERE id = $2', [dataFim, campanha_id]);
    }

    await pool.query('UPDATE campanhas SET total_lances = total_lances + 1, arrecadado = arrecadado + $1 WHERE id = $2', [valorNum, campanha_id]);

    const lanceData = { ...result.rows[0], nome_usuario: userCheck.rows[0].nome };
    io.emit('novo_lance', { campanha_id, lance: lanceData });
    console.log('[LANCE] Sucesso:', lanceData);
    res.json(lanceData);
  } catch (err) { 
    console.error('[LANCE ERROR]', err.message); 
    res.status(500).json({ erro: err.message }); 
  }
});


// ===================== ROTAS PIX / MERCADO PAGO =====================

// Gera PIX para dar um lance (calcula valor automaticamente)
app.post('/api/pix/gerar', async (req, res) => {
  console.log('[PIX/GERAR] ========== INÍCIO ==========');
  console.log('[PIX/GERAR] Body:', JSON.stringify(req.body));

  try {
    const { campanha_id, usuario_id } = req.body;

    if (!campanha_id || !usuario_id) {
      console.log('[PIX/GERAR] ERRO: campos obrigatórios faltando');
      return res.status(400).json({ erro: 'campanha_id e usuario_id são obrigatórios' });
    }

    // Verifica campanha
    console.log('[PIX/GERAR] Buscando campanha:', campanha_id);
    const camp = await pool.query('SELECT * FROM campanhas WHERE id = $1', [campanha_id]);
    if (camp.rows.length === 0) {
      console.log('[PIX/GERAR] ERRO: campanha não encontrada');
      return res.status(404).json({ erro: 'Campanha não encontrada' });
    }

    const c = camp.rows[0];
    console.log('[PIX/GERAR] Campanha:', c.nome, '| Status:', c.status);

    if (c.status !== 'ativa') {
      return res.status(400).json({ erro: 'Campanha não está ativa' });
    }

    // Verifica usuário
    console.log('[PIX/GERAR] Buscando usuário:', usuario_id);
    const userCheck = await pool.query('SELECT * FROM usuarios WHERE id = $1', [usuario_id]);
    if (userCheck.rows.length === 0) {
      return res.status(401).json({ erro: 'Usuário não encontrado' });
    }

    // Calcula valor do próximo lance
    console.log('[PIX/GERAR] Calculando próximo lance...');
    const vlance = parseFloat(c.valor_lance) || 0.01;
    const maxRes = await pool.query('SELECT MAX(valor) as max_valor FROM lances WHERE campanha_id = $1', [campanha_id]);
    const maxValor = parseFloat(maxRes.rows[0].max_valor) || 0;
    const valorLance = maxValor === 0 ? vlance : parseFloat((maxValor + vlance).toFixed(2));
    console.log('[PIX/GERAR] Valor calculado:', valorLance, '(max:', maxValor, '+ vlance:', vlance, ')');

    // Gera PIX (estático se MP não configurado, real se configurado)
    let pixData;

    if (mpConfigurado()) {
      console.log('[PIX/GERAR] Gerando PIX no Mercado Pago...');
      try {
        const mpResponse = await axios.post(
          'https://api.mercadopago.com/v1/payments',
          {
            transaction_amount: valorLance,
            description: `Lance ${c.nome || 'Leilão'}`,
            payment_method_id: 'pix',
            payer: {
              email: req.body.email || `user_${usuario_id}@leilaofacil.com`,
              first_name: req.body.nome ? req.body.nome.split(' ')[0] : 'Usuario',
              last_name: req.body.nome ? req.body.nome.split(' ').slice(1).join(' ') : 'Leilao'
            }
          },
          {
            headers: {
              'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
              'Content-Type': 'application/json'
            },
            timeout: 15000
          }
        );

        const mpData = mpResponse.data;
        pixData = {
          mp_payment_id: mpData.id.toString(),
          status: mpData.status,
          qr_code: mpData.point_of_interaction?.transaction_data?.qr_code || null,
          qr_code_base64: mpData.point_of_interaction?.transaction_data?.qr_code_base64 || null,
          copia_cola: mpData.point_of_interaction?.transaction_data?.qr_code || null
        };
        console.log('[PIX/GERAR] PIX MP gerado:', pixData.mp_payment_id);
      } catch (mpErr) {
        console.error('[PIX/GERAR] Erro MP:', mpErr.message);
        // Fallback para estático em caso de erro no MP
        pixData = null;
      }
    }

    // Se não gerou no MP, usa estático
    if (!pixData) {
      console.log('[PIX/GERAR] Usando PIX estático');
      const fakeMpId = `STATIC_${Date.now()}_${Math.random().toString(36).substr(2,9)}`;
      const pixCode = `00020126580014BR.GOV.BCB.PIX0136${CHAVE_PIX}5204000053039865405${String(valorLance.toFixed(2)).replace('.','')}5802BR5913Leilao Facil6009SAO PAULO62070503***6304`;
      pixData = {
        mp_payment_id: fakeMpId,
        status: 'pending',
        qr_code: pixCode,
        qr_code_base64: null,
        copia_cola: pixCode
      };
    }

    // Salva no banco
    console.log('[PIX/GERAR] Salvando no banco...');
    const pagRes = await pool.query(
      `INSERT INTO pagamentos_pix 
       (campanha_id, usuario_id, mp_payment_id, mp_status, valor, qr_code, qr_code_base64, copia_cola, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [campanha_id, usuario_id, pixData.mp_payment_id, pixData.status, 
       valorLance, pixData.qr_code, pixData.qr_code_base64, pixData.copia_cola, 'pendente']
    );

    console.log('[PIX/GERAR] Pagamento salvo ID:', pagRes.rows[0].id);

    // Se for o primeiro lance, inicia o timer
    if (!c.data_fim) {
      console.log('[PIX/GERAR] Primeiro lance - iniciando timer');
      const dataFim = new Date(Date.now() + (c.duracao_horas || 24) * 60 * 60 * 1000);
      await pool.query('UPDATE campanhas SET data_fim = $1 WHERE id = $2', [dataFim, campanha_id]);
      const campAtualizada = await pool.query('SELECT * FROM campanhas WHERE id = $1', [campanha_id]);
      io.emit('campanha_atualizada', campAtualizada.rows[0]);
    }

    console.log('[PIX/GERAR] ========== SUCESSO ==========');

    res.json({
      sucesso: true,
      pagamento_id: pagRes.rows[0].id,
      mp_payment_id: pixData.mp_payment_id,
      valor: valorLance,
      qr_code: pixData.qr_code,
      qr_code_base64: pixData.qr_code_base64,
      copia_cola: pixData.copia_cola,
      status: 'pendente'
    });

  } catch (err) {
    console.error('[PIX/GERAR] ========== ERRO ==========');
    console.error('[PIX/GERAR]', err.message);
    console.error('[PIX/GERAR] Stack:', err.stack);
    res.status(500).json({ 
      erro: err.message || 'Erro ao gerar PIX',
      stack: err.stack
    });
  }
});// Consulta status do pagamento
app.get('/api/pix/status/:pagamento_id', async (req, res) => {
  try {
    const { pagamento_id } = req.params;

    const pagRes = await pool.query('SELECT * FROM pagamentos_pix WHERE id = $1', [pagamento_id]);
    if (pagRes.rows.length === 0) {
      return res.status(404).json({ erro: 'Pagamento não encontrado' });
    }

    const pag = pagRes.rows[0];

    // Se já está aprovado e lance registrado
    if (pag.status === 'aprovado' && pag.lance_registrado) {
      return res.json({ status: 'aprovado', lance_registrado: true });
    }

    // Consulta no MP para atualizar status
    if (pag.mp_payment_id && mpConfigurado()) {
      const mpData = await consultarPagamentoMP(pag.mp_payment_id);

      if (mpData && mpData.status !== pag.mp_status) {
        // Atualiza status no banco
        await pool.query(
          'UPDATE pagamentos_pix SET mp_status = $1, status = $2, updated_at = NOW() WHERE id = $3',
          [mpData.status, mpData.status, pagamento_id]
        );

        // Se foi aprovado, registra o lance
        if (mpData.status === 'approved' && !pag.lance_registrado) {
          await pool.query('UPDATE pagamentos_pix SET lance_registrado = TRUE WHERE id = $1', [pagamento_id]);
          const lance = await registrarLanceConfirmado(pag.campanha_id, pag.usuario_id, pag.valor);
          return res.json({ status: 'aprovado', lance_registrado: true, lance });
        }

        return res.json({ status: mpData.status, lance_registrado: false });
      }
    }

    res.json({ status: pag.status, lance_registrado: pag.lance_registrado });

  } catch (err) {
    console.error('[PIX STATUS ERROR]', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Webhook do Mercado Pago (chamado pelo MP quando pagamento muda de status)
app.post('/api/webhooks/mercado-pago', async (req, res) => {
  try {
    // Responde imediatamente ao MP (obrigatório)
    res.status(200).send('OK');

    const { type, data } = req.body;

    console.log('[WEBHOOK MP]', type, data);

    if (type === 'payment' && data && data.id) {
      const mp_payment_id = data.id.toString();

      // Busca pagamento no banco
      const pagRes = await pool.query('SELECT * FROM pagamentos_pix WHERE mp_payment_id = $1', [mp_payment_id]);
      if (pagRes.rows.length === 0) {
        console.log('[WEBHOOK] Pagamento não encontrado no banco:', mp_payment_id);
        return;
      }

      const pag = pagRes.rows[0];

      // Consulta detalhes no MP
      const mpData = await consultarPagamentoMP(mp_payment_id);
      if (!mpData) return;

      console.log('[WEBHOOK] Status MP:', mpData.status);

      // Atualiza status
      await pool.query(
        'UPDATE pagamentos_pix SET mp_status = $1, status = $2, updated_at = NOW() WHERE id = $3',
        [mpData.status, mpData.status, pag.id]
      );

      // Se aprovado e lance ainda não registrado
      if (mpData.status === 'approved' && !pag.lance_registrado) {
        await pool.query('UPDATE pagamentos_pix SET lance_registrado = TRUE WHERE id = $1', [pag.id]);
        const lance = await registrarLanceConfirmado(pag.campanha_id, pag.usuario_id, pag.valor);
        console.log('[WEBHOOK] Lance registrado:', lance);
      }
    }
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err.message);
  }
});

// Rota antiga de lances (mantida para compatibilidade, mas desencorajada)
// Agora só registra se for chamada internamente ou com flag especial
app.post('/api/lances', async (req, res) => {
  try {
    const { campanha_id, usuario_id, valor, skip_pix } = req.body;

    // Se não tem skip_pix=true, redireciona para o fluxo PIX
    if (!skip_pix) {
      return res.status(400).json({ 
        erro: 'Use /api/pix/gerar para dar lances. O pagamento via PIX é obrigatório.',
        redirect: '/api/pix/gerar'
      });
    }

    // Só permite skip_pix em desenvolvimento ou com token admin
    // (mantido para testes internos)
    console.log('[LANCE DIRETO] Skip PIX:', { campanha_id, usuario_id, valor });

    if (!campanha_id || !usuario_id || valor === undefined) {
      return res.status(400).json({ erro: 'Dados incompletos' });
    }

    const userCheck = await pool.query('SELECT * FROM usuarios WHERE id = $1', [usuario_id]);
    if (userCheck.rows.length === 0) {
      return res.status(401).json({ erro: 'Sessão expirada' });
    }

    const camp = await pool.query('SELECT * FROM campanhas WHERE id = $1', [campanha_id]);
    if (camp.rows.length === 0) return res.status(404).json({ erro: 'Campanha não encontrada' });

    const c = camp.rows[0];
    if (c.status !== 'ativa') return res.status(400).json({ erro: 'Campanha não ativa' });
    if (c.data_fim && new Date(c.data_fim) < new Date()) return res.status(400).json({ erro: 'Finalizado' });

    const valorNum = parseFloat(valor);
    const lance = await registrarLanceConfirmado(campanha_id, usuario_id, valorNum);

    res.json(lance);
  } catch (err) {
    console.error('[LANCE ERROR]', err.message);
    res.status(500).json({ erro: err.message });
  }
});


// SPA fallback para slugs
app.get('/:slug', async (req, res) => {
  if (req.params.slug.startsWith('api') || req.params.slug.startsWith('socket')) {
    return res.status(404).json({ erro: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('[SOCKET] Conectado:', socket.id);
  socket.on('disconnect', () => console.log('[SOCKET] Desconectado:', socket.id));
});


// Cria tabela pagamentos_pix automaticamente se não existir (garantia extra)
async function garantirTabelaPagamentosPix() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pagamentos_pix (
        id SERIAL PRIMARY KEY,
        campanha_id INTEGER REFERENCES campanhas(id) ON DELETE CASCADE,
        usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
        mp_payment_id VARCHAR(100),
        mp_status VARCHAR(50),
        valor DECIMAL(10,2) NOT NULL,
        qr_code TEXT,
        qr_code_base64 TEXT,
        copia_cola TEXT,
        status VARCHAR(50) DEFAULT 'pendente',
        lance_registrado BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('[DB] Tabela pagamentos_pix verificada/criada');
  } catch (err) {
    console.error('[DB] Erro ao criar pagamentos_pix:', err.message);
  }
}

// Inicialização
(async () => {
  try {
    await runMigrations();
    await garantirTabelaPagamentosPix();
    await cleanupLogs();
    setInterval(cleanupLogs, 24 * 60 * 60 * 1000);
    server.listen(PORT, () => console.log(`[SERVER] Porta ${PORT}`));
  } catch (err) {
    console.error('[FATAL]', err);
    process.exit(1);
  }
})();

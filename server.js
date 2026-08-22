const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Supabase client (lazy)
let supabase = null;
function getSupabase() {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(url, key);
  return supabase;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.use(cors());
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ============================================================
// SISTEMA DE LOGS PERMANENTE
// ============================================================
async function registrarLog(nivel, rota, metodo, mensagem, payload, erro) {
  try {
    await pool.query(
      `INSERT INTO system_logs (nivel, rota, metodo, mensagem, payload, erro, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [nivel, rota, metodo, mensagem, payload ? JSON.stringify(payload) : null, erro ? erro.toString().substring(0,2000) : null]
    );
  } catch (e) {
    console.error('[LOG FAIL]', e.message);
  }
}

// Middleware de log global
app.use((req, res, next) => {
  const start = Date.now();
  const rota = req.path;
  const metodo = req.method;

  res.on('finish', async () => {
    const duracao = Date.now() - start;
    const status = res.statusCode;
    const nivel = status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : 'INFO';
    const payload = metodo !== 'GET' ? { body: req.body, query: req.query } : { query: req.query };

    await registrarLog(
      nivel, rota, metodo,
      `${status} | ${duracao}ms`,
      payload,
      status >= 400 ? `HTTP ${status}` : null
    );
  });

  next();
});

// ============================================================
// AUTO-MIGRATION
// ============================================================
async function runMigrations() {
  try {
    console.log('[MIGRATION] Iniciando...');

    // Tabela de logs permanente
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_logs (
        id SERIAL PRIMARY KEY,
        nivel VARCHAR(10) NOT NULL CHECK (nivel IN ('INFO','WARN','ERROR','DEBUG')),
        rota VARCHAR(255),
        metodo VARCHAR(10),
        mensagem TEXT,
        payload JSONB,
        erro TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Administradores
    await pool.query(`
      CREATE TABLE IF NOT EXISTS administradores (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL DEFAULT 'Admin',
        email VARCHAR(255) UNIQUE NOT NULL,
        senha VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    const { rows: admins } = await pool.query('SELECT COUNT(*) as total FROM administradores');
    if (parseInt(admins[0].total) === 0) {
      const senhaHash = await bcrypt.hash('admin123', 10);
      await pool.query('INSERT INTO administradores (nome, email, senha) VALUES ($1, $2, $3)',
        ['Administrador', 'admin@leilao.com', senhaHash]);
      console.log('[MIGRATION] Admin criado: admin@leilao.com / admin123');
    }

    // Campanhas
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campanhas (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        slug VARCHAR(255) UNIQUE NOT NULL,
        descricao TEXT,
        premio_imagem TEXT,
        meta_valor DECIMAL(12,2) DEFAULT 0,
        lance_inicial DECIMAL(12,2) DEFAULT 0.01,
        duracao_horas INTEGER DEFAULT 24,
        status VARCHAR(20) DEFAULT 'pendente',
        data_inicio TIMESTAMP,
        data_fim TIMESTAMP,
        influencer_id INTEGER,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`ALTER TABLE campanhas DROP CONSTRAINT IF EXISTS campanhas_status_check`);
    await pool.query(`ALTER TABLE campanhas ADD CONSTRAINT campanhas_status_check CHECK (status IN ('pendente', 'ativa', 'pausada', 'finalizada'))`);

    // Usuarios
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Lances
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lances (
        id SERIAL PRIMARY KEY,
        campanha_id INTEGER NOT NULL,
        usuario_id INTEGER NOT NULL,
        usuario_nome VARCHAR(255),
        valor DECIMAL(12,2) NOT NULL,
        data_hora TIMESTAMP DEFAULT NOW()
      )
    `);

    // Pagamentos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pagamentos (
        id SERIAL PRIMARY KEY,
        campanha_id INTEGER NOT NULL,
        usuario_id INTEGER NOT NULL,
        valor DECIMAL(12,2) NOT NULL,
        status VARCHAR(20) DEFAULT 'pendente',
        transacao_id VARCHAR(255),
        pix_qr_code TEXT,
        pix_link TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Influencers
    await pool.query(`
      CREATE TABLE IF NOT EXISTS influencers (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        telefone VARCHAR(50),
        codigo VARCHAR(50) UNIQUE,
        comissao DECIMAL(5,2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Configuracoes
    await pool.query(`
      CREATE TABLE IF NOT EXISTS configuracoes (
        id INTEGER PRIMARY KEY DEFAULT 1,
        lance_padrao DECIMAL(12,2) DEFAULT 0.01,
        duracao_padrao INTEGER DEFAULT 24,
        taxa_pix DECIMAL(5,2) DEFAULT 0,
        CONSTRAINT single_row CHECK (id = 1)
      )
    `);

    console.log('[MIGRATION] OK');
    await registrarLog('INFO', '/migration', 'SYS', 'Migrations executadas com sucesso', null, null);
  } catch (err) {
    console.error('[MIGRATION ERROR]', err.message);
    await registrarLog('ERROR', '/migration', 'SYS', 'Falha na migration', null, err);
  }
}

// Auth middleware
const authAdmin = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ erro: 'Token ausente' });
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET || 'segredo-leilao');
    next();
  } catch (e) {
    return res.status(401).json({ erro: 'Token inválido' });
  }
};

// ============================================================
// ROTAS ADMIN
// ============================================================

// Logs do sistema
app.get('/api/admin/logs', authAdmin, async (req, res) => {
  try {
    const { nivel, limite = 100 } = req.query;
    let sql = 'SELECT * FROM system_logs';
    const params = [];
    if (nivel && nivel !== 'todos') {
      sql += ' WHERE nivel = $1';
      params.push(nivel);
    }
    sql += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
    params.push(parseInt(limite) || 100);
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    await registrarLog('ERROR', '/api/admin/logs', 'GET', 'Erro ao buscar logs', req.query, err);
    res.status(500).json({ erro: err.message });
  }
});

// Health check
app.get('/api/health', async (req, res) => {
  const checks = { database: false, supabase: false, timestamp: new Date().toISOString() };
  try {
    await pool.query('SELECT 1');
    checks.database = true;
  } catch (e) { checks.database_error = e.message; }

  try {
    const sb = getSupabase();
    checks.supabase = !!sb;
    if (sb) {
      const { data } = await sb.storage.from('leilao-facil').list('campanhas', { limit: 1 });
      checks.supabase_bucket = data !== null;
    }
  } catch (e) { checks.supabase_error = e.message; }

  const ok = checks.database;
  res.status(ok ? 200 : 503).json(checks);
});

// Login admin
app.post('/api/admin/login', async (req, res) => {
  const { email, senha } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM administradores WHERE email = $1', [email]);
    if (rows.length === 0) {
      await registrarLog('WARN', '/api/admin/login', 'POST', 'Login falhou - email nao encontrado', { email }, null);
      return res.status(401).json({ erro: 'Credenciais inválidas' });
    }
    const admin = rows[0];
    const ok = await bcrypt.compare(senha, admin.senha);
    const plainOk = (senha === admin.senha);
    if (!ok && !plainOk) {
      await registrarLog('WARN', '/api/admin/login', 'POST', 'Login falhou - senha incorreta', { email }, null);
      return res.status(401).json({ erro: 'Credenciais inválidas' });
    }
    const token = jwt.sign({ id: admin.id, email: admin.email }, process.env.JWT_SECRET || 'segredo-leilao', { expiresIn: '8h' });
    await registrarLog('INFO', '/api/admin/login', 'POST', 'Login sucesso', { email, admin_id: admin.id }, null);
    res.json({ token, admin: { id: admin.id, nome: admin.nome, email: admin.email } });
  } catch (err) {
    await registrarLog('ERROR', '/api/admin/login', 'POST', 'Erro no login', req.body, err);
    res.status(500).json({ erro: err.message });
  }
});

// Dashboard
app.get('/api/admin/dashboard', authAdmin, async (req, res) => {
  try {
    const campanhas = await pool.query('SELECT COUNT(*) as total FROM campanhas');
    const ativas = await pool.query("SELECT COUNT(*) as total FROM campanhas WHERE status = 'ativa'");
    const usuarios = await pool.query('SELECT COUNT(*) as total FROM usuarios');
    const arrecadado = await pool.query("SELECT COALESCE(SUM(valor),0) as total FROM pagamentos WHERE status = 'aprovado'");
    res.json({
      totalCampanhas: parseInt(campanhas.rows[0].total),
      campanhasAtivas: parseInt(ativas.rows[0].total),
      totalUsuarios: parseInt(usuarios.rows[0].total),
      totalArrecadado: parseFloat(arrecadado.rows[0].total)
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Listar campanhas
app.get('/api/admin/campanhas', authAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT c.*, i.nome as influencer_nome FROM campanhas c LEFT JOIN influencers i ON c.influencer_id = i.id ORDER BY c.created_at DESC`);
    res.json(rows);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Criar campanha
app.post('/api/admin/campanhas', authAdmin, async (req, res) => {
  const { nome, slug, descricao, premio_imagem, meta_valor, lance_inicial, duracao_horas, influencer_id } = req.body;
  try {
    const { rows } = await pool.query(`
      INSERT INTO campanhas (nome, slug, descricao, premio_imagem, meta_valor, lance_inicial, duracao_horas, status, influencer_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'pendente', $8) RETURNING *
    `, [nome, slug, descricao, premio_imagem || null, meta_valor, lance_inicial, duracao_horas, influencer_id || null]);
    await registrarLog('INFO', '/api/admin/campanhas', 'POST', 'Campanha criada', { nome, slug }, null);
    res.status(201).json(rows[0]);
  } catch (err) {
    await registrarLog('ERROR', '/api/admin/campanhas', 'POST', 'Erro ao criar campanha', req.body, err);
    res.status(500).json({ erro: err.message });
  }
});

// Atualizar campanha
app.put('/api/admin/campanhas/:id', authAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows: atual } = await pool.query('SELECT * FROM campanhas WHERE id = $1', [id]);
    if (atual.length === 0) return res.status(404).json({ erro: 'Campanha não encontrada' });

    const c = atual[0];
    const nome = req.body.nome !== undefined ? req.body.nome : c.nome;
    const slug = req.body.slug !== undefined ? req.body.slug : c.slug;
    const descricao = req.body.descricao !== undefined ? req.body.descricao : c.descricao;
    const premio_imagem = req.body.premio_imagem !== undefined ? req.body.premio_imagem : c.premio_imagem;
    const meta_valor = req.body.meta_valor !== undefined ? req.body.meta_valor : c.meta_valor;
    const lance_inicial = req.body.lance_inicial !== undefined ? req.body.lance_inicial : c.lance_inicial;
    const duracao_horas = req.body.duracao_horas !== undefined ? req.body.duracao_horas : c.duracao_horas;
    const status = req.body.status !== undefined ? req.body.status : c.status;
    const influencer_id = req.body.influencer_id !== undefined ? req.body.influencer_id : c.influencer_id;

    const { rows } = await pool.query(`
      UPDATE campanhas 
      SET nome = $1, slug = $2, descricao = $3, premio_imagem = $4, meta_valor = $5, 
          lance_inicial = $6, duracao_horas = $7, status = $8, influencer_id = $9, updated_at = NOW()
      WHERE id = $10 RETURNING *
    `, [nome, slug, descricao, premio_imagem, meta_valor, lance_inicial, duracao_horas, status, influencer_id, id]);

    await registrarLog('INFO', '/api/admin/campanhas/'+id, 'PUT', 'Campanha atualizada', { nome, status }, null);
    res.json(rows[0]);
  } catch (err) {
    await registrarLog('ERROR', '/api/admin/campanhas/'+id, 'PUT', 'Erro ao atualizar campanha', req.body, err);
    res.status(500).json({ erro: err.message });
  }
});

// Excluir campanha
app.delete('/api/admin/campanhas/:id', authAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM campanhas WHERE id = $1', [req.params.id]);
    await registrarLog('INFO', '/api/admin/campanhas/'+req.params.id, 'DELETE', 'Campanha excluida', null, null);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Upload de imagem
app.post('/api/upload-imagem', authAdmin, upload.single('imagem'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Nenhuma imagem enviada' });
    const sb = getSupabase();
    if (!sb) {
      await registrarLog('WARN', '/api/upload-imagem', 'POST', 'Upload nao configurado', null, null);
      return res.status(503).json({ erro: 'Upload não configurado. Use URL externa.' });
    }
    const ext = path.extname(req.file.originalname) || '.jpg';
    const fileName = `campanhas/${Date.now()}-${Math.random().toString(36).substring(2)}${ext}`;
    const { data, error } = await sb.storage.from('leilao-facil').upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
    if (error) {
      await registrarLog('ERROR', '/api/upload-imagem', 'POST', 'Erro upload Supabase', null, error);
      return res.status(500).json({ erro: 'Erro upload: ' + error.message });
    }
    const { data: urlData } = sb.storage.from('leilao-facil').getPublicUrl(fileName);
    await registrarLog('INFO', '/api/upload-imagem', 'POST', 'Upload OK', { url: urlData.publicUrl }, null);
    res.json({ url: urlData.publicUrl });
  } catch (err) {
    await registrarLog('ERROR', '/api/upload-imagem', 'POST', 'Erro upload', null, err);
    res.status(500).json({ erro: err.message });
  }
});

// Influencers
app.get('/api/admin/influencers', authAdmin, async (req, res) => {
  try { const { rows } = await pool.query('SELECT * FROM influencers ORDER BY nome'); res.json(rows); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/admin/influencers', authAdmin, async (req, res) => {
  const { nome, email, telefone, codigo, comissao } = req.body;
  try { const { rows } = await pool.query('INSERT INTO influencers (nome, email, telefone, codigo, comissao) VALUES ($1,$2,$3,$4,$5) RETURNING *', [nome, email, telefone, codigo, comissao]); res.status(201).json(rows[0]); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

app.put('/api/admin/influencers/:id', authAdmin, async (req, res) => {
  const { nome, email, telefone, codigo, comissao } = req.body;
  try { const { rows } = await pool.query('UPDATE influencers SET nome=$1, email=$2, telefone=$3, codigo=$4, comissao=$5 WHERE id=$6 RETURNING *', [nome, email, telefone, codigo, comissao, req.params.id]); res.json(rows[0]); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

app.delete('/api/admin/influencers/:id', authAdmin, async (req, res) => {
  try { await pool.query('DELETE FROM influencers WHERE id = $1', [req.params.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// Usuários
app.get('/api/admin/usuarios', authAdmin, async (req, res) => {
  try { const { rows } = await pool.query('SELECT * FROM usuarios ORDER BY created_at DESC'); res.json(rows); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// Configurações
app.get('/api/admin/configuracoes', authAdmin, async (req, res) => {
  try { const { rows } = await pool.query('SELECT * FROM configuracoes LIMIT 1'); res.json(rows[0] || {}); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

app.put('/api/admin/configuracoes', authAdmin, async (req, res) => {
  const { lance_padrao, duracao_padrao, taxa_pix } = req.body;
  try { const { rows } = await pool.query(`INSERT INTO configuracoes (id, lance_padrao, duracao_padrao, taxa_pix) VALUES (1, $1, $2, $3) ON CONFLICT (id) DO UPDATE SET lance_padrao=$1, duracao_padrao=$2, taxa_pix=$3 RETURNING *`, [lance_padrao, duracao_padrao, taxa_pix]); res.json(rows[0]); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// ============================================================
// ROTAS PÚBLICAS
// ============================================================

app.get('/api/campanha/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT c.*, i.nome as influencer_nome, i.codigo as influencer_codigo FROM campanhas c LEFT JOIN influencers i ON c.influencer_id = i.id WHERE c.slug = $1 AND c.status = 'ativa'`, [req.params.slug]);
    if (rows.length === 0) return res.status(404).json({ erro: 'Leilão não encontrado' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/usuario', async (req, res) => {
  const { nome, email } = req.body;
  try {
    let { rows } = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
    if (rows.length === 0) { const result = await pool.query('INSERT INTO usuarios (nome, email) VALUES ($1, $2) RETURNING *', [nome, email]); rows = result.rows; }
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/ranking/:campanhaId', async (req, res) => {
  try { const { rows } = await pool.query('SELECT usuario_nome, SUM(valor) as total, COUNT(*) as lances FROM lances WHERE campanha_id = $1 GROUP BY usuario_nome ORDER BY total DESC LIMIT 10', [req.params.campanhaId]); res.json(rows); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/criar-pagamento', async (req, res) => {
  const { campanha_id, usuario_id, valor } = req.body;
  try {
    const txid = 'TX' + Date.now() + Math.random().toString(36).substr(2, 5).toUpperCase();
    const { rows } = await pool.query(`INSERT INTO pagamentos (campanha_id, usuario_id, valor, status, transacao_id, pix_qr_code, pix_link) VALUES ($1, $2, $3, 'pendente', $4, $5, $6) RETURNING *`, [campanha_id, usuario_id, valor, txid, `00020126580014BR.GOV.BCB.PIX0136${txid}520400005303986540${valor.toFixed(2)}5802BR5913Leilao Facil6009SAO PAULO62070503***6304`, `https://leilao-facil.onrender.com/pix/${txid}`]);
    res.json({ id: rows[0].id, transacao_id: txid, pix_qr_code: rows[0].pix_qr_code, pix_link: rows[0].pix_link, valor });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/confirmar-pagamento', async (req, res) => {
  const { pagamento_id, usuario_id, usuario_nome, campanha_id, valor } = req.body;
  try {
    await pool.query("UPDATE pagamentos SET status = 'aprovado' WHERE id = $1", [pagamento_id]);
    const { rows } = await pool.query('INSERT INTO lances (campanha_id, usuario_id, usuario_nome, valor, data_hora) VALUES ($1, $2, $3, $4, NOW()) RETURNING *', [campanha_id, usuario_id, usuario_nome, valor]);
    await pool.query('UPDATE campanhas SET data_fim = COALESCE(data_fim, NOW() + INTERVAL \'1 hour\' * duracao_horas), data_inicio = COALESCE(data_inicio, NOW()) WHERE id = $1 AND data_inicio IS NULL', [campanha_id]);
    const camp = await pool.query('SELECT * FROM campanhas WHERE id = $1', [campanha_id]);
    io.emit('novo-lance', { lance: rows[0], campanha: camp.rows[0] });
    res.json({ sucesso: true, lance: rows[0] });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// SOCKET.IO
io.on('connection', (socket) => {
  console.log('[SOCKET] Conectado:', socket.id);
  socket.on('join-campanha', (id) => socket.join(`campanha-${id}`));
  socket.on('disconnect', () => console.log('[SOCKET] Desconectado:', socket.id));
});

setInterval(async () => {
  try { await pool.query("UPDATE campanhas SET status = 'finalizada' WHERE status = 'ativa' AND data_fim IS NOT NULL AND data_fim < NOW()"); }
  catch (e) { console.error('[TIMER]', e); }
}, 30000);

async function start() {
  await runMigrations();
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`[SERVER] Porta ${PORT}`));
}
start();

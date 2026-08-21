const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Supabase client (para Storage)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// PostgreSQL pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Multer config (memória)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Middlewares
app.use(cors());
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Auth middleware admin
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

// Login admin
app.post('/api/admin/login', async (req, res) => {
  const { email, senha } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM administradores WHERE email = $1', [email]);
    if (rows.length === 0) return res.status(401).json({ erro: 'Credenciais inválidas' });
    const admin = rows[0];
    const ok = await bcrypt.compare(senha, admin.senha);
    if (!ok) return res.status(401).json({ erro: 'Credenciais inválidas' });
    const token = jwt.sign({ id: admin.id, email: admin.email }, process.env.JWT_SECRET || 'segredo-leilao', { expiresIn: '8h' });
    res.json({ token, admin: { id: admin.id, nome: admin.nome, email: admin.email } });
  } catch (err) {
    console.error('[LOGIN]', err);
    res.status(500).json({ erro: 'Erro no servidor' });
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
  } catch (err) {
    console.error('[DASHBOARD]', err);
    res.status(500).json({ erro: err.message });
  }
});

// Listar campanhas
app.get('/api/admin/campanhas', authAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, i.nome as influencer_nome 
      FROM campanhas c 
      LEFT JOIN influencers i ON c.influencer_id = i.id 
      ORDER BY c.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('[CAMPANHAS LIST]', err);
    res.status(500).json({ erro: err.message });
  }
});

// Criar campanha
app.post('/api/admin/campanhas', authAdmin, async (req, res) => {
  const { nome, slug, descricao, premio_imagem, meta_valor, lance_inicial, duracao_horas, influencer_id } = req.body;
  try {
    const { rows } = await pool.query(`
      INSERT INTO campanhas (nome, slug, descricao, premio_imagem, meta_valor, lance_inicial, duracao_horas, status, influencer_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'pendente', $8)
      RETURNING *
    `, [nome, slug, descricao, premio_imagem || null, meta_valor, lance_inicial, duracao_horas, influencer_id || null]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[CAMPANHA CREATE]', err);
    res.status(500).json({ erro: err.message });
  }
});

// Atualizar campanha
app.put('/api/admin/campanhas/:id', authAdmin, async (req, res) => {
  const { id } = req.params;
  const { nome, slug, descricao, premio_imagem, meta_valor, lance_inicial, duracao_horas, status, influencer_id } = req.body;
  try {
    const { rows } = await pool.query(`
      UPDATE campanhas 
      SET nome = $1, slug = $2, descricao = $3, premio_imagem = $4, meta_valor = $5, 
          lance_inicial = $6, duracao_horas = $7, status = $8, influencer_id = $9, updated_at = NOW()
      WHERE id = $10
      RETURNING *
    `, [nome, slug, descricao, premio_imagem || null, meta_valor, lance_inicial, duracao_horas, status, influencer_id || null, id]);
    if (rows.length === 0) return res.status(404).json({ erro: 'Campanha não encontrada' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[CAMPANHA UPDATE]', err);
    res.status(500).json({ erro: err.message });
  }
});

// Excluir campanha
app.delete('/api/admin/campanhas/:id', authAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM campanhas WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[CAMPANHA DELETE]', err);
    res.status(500).json({ erro: err.message });
  }
});

// Upload de imagem para Supabase Storage
app.post('/api/upload-imagem', authAdmin, upload.single('imagem'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Nenhuma imagem enviada' });

    const ext = path.extname(req.file.originalname) || '.jpg';
    const fileName = `campanhas/${Date.now()}-${Math.random().toString(36).substring(2)}${ext}`;

    const { data, error } = await supabase.storage
      .from('leilao-facil')
      .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });

    if (error) {
      console.error('[UPLOAD ERROR]', error);
      return res.status(500).json({ erro: 'Erro ao fazer upload: ' + error.message });
    }

    const { data: urlData } = supabase.storage.from('leilao-facil').getPublicUrl(fileName);
    res.json({ url: urlData.publicUrl });
  } catch (err) {
    console.error('[UPLOAD]', err);
    res.status(500).json({ erro: err.message });
  }
});

// Influencers
app.get('/api/admin/influencers', authAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM influencers ORDER BY nome');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/admin/influencers', authAdmin, async (req, res) => {
  const { nome, email, telefone, codigo, comissao } = req.body;
  try {
    const { rows } = await pool.query(
      'INSERT INTO influencers (nome, email, telefone, codigo, comissao) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [nome, email, telefone, codigo, comissao]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.put('/api/admin/influencers/:id', authAdmin, async (req, res) => {
  const { nome, email, telefone, codigo, comissao } = req.body;
  try {
    const { rows } = await pool.query(
      'UPDATE influencers SET nome=$1, email=$2, telefone=$3, codigo=$4, comissao=$5 WHERE id=$6 RETURNING *',
      [nome, email, telefone, codigo, comissao, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.delete('/api/admin/influencers/:id', authAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM influencers WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Usuários
app.get('/api/admin/usuarios', authAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM usuarios ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Configurações
app.get('/api/admin/configuracoes', authAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM configuracoes LIMIT 1');
    res.json(rows[0] || {});
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.put('/api/admin/configuracoes', authAdmin, async (req, res) => {
  const { lance_padrao, duracao_padrao, taxa_pix } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO configuracoes (lance_padrao, duracao_padrao, taxa_pix) 
       VALUES ($1,$2,$3) 
       ON CONFLICT (id) DO UPDATE SET lance_padrao=$1, duracao_padrao=$2, taxa_pix=$3 
       RETURNING *`,
      [lance_padrao, duracao_padrao, taxa_pix]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ============================================================
// ROTAS PÚBLICAS (LEILÃO)
// ============================================================

// Buscar campanha por slug
app.get('/api/campanha/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, i.nome as influencer_nome, i.codigo as influencer_codigo
      FROM campanhas c
      LEFT JOIN influencers i ON c.influencer_id = i.id
      WHERE c.slug = $1 AND c.status = 'ativa'
    `, [req.params.slug]);
    if (rows.length === 0) return res.status(404).json({ erro: 'Leilão não encontrado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Criar ou buscar usuário
app.post('/api/usuario', async (req, res) => {
  const { nome, email } = req.body;
  try {
    let { rows } = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
    if (rows.length === 0) {
      const result = await pool.query(
        'INSERT INTO usuarios (nome, email) VALUES ($1, $2) RETURNING *',
        [nome, email]
      );
      rows = result.rows;
    }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Ranking de lances
app.get('/api/ranking/:campanhaId', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT usuario_nome, SUM(valor) as total, COUNT(*) as lances
      FROM lances WHERE campanha_id = $1
      GROUP BY usuario_nome ORDER BY total DESC LIMIT 10
    `, [req.params.campanhaId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Criar pagamento (PIX simulado)
app.post('/api/criar-pagamento', async (req, res) => {
  const { campanha_id, usuario_id, valor } = req.body;
  try {
    const txid = 'TX' + Date.now() + Math.random().toString(36).substr(2, 5).toUpperCase();
    const { rows } = await pool.query(`
      INSERT INTO pagamentos (campanha_id, usuario_id, valor, status, transacao_id, pix_qr_code, pix_link)
      VALUES ($1, $2, $3, 'pendente', $4, $5, $6)
      RETURNING *
    `, [campanha_id, usuario_id, valor, txid, `00020126580014BR.GOV.BCB.PIX0136${txid}520400005303986540${valor.toFixed(2)}5802BR5913Leilao Facil6009SAO PAULO62070503***6304`, `https://leilao-facil.onrender.com/pix/${txid}`]);

    res.json({
      id: rows[0].id,
      transacao_id: txid,
      pix_qr_code: rows[0].pix_qr_code,
      pix_link: rows[0].pix_link,
      valor: valor
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Confirmar pagamento manual (simulação)
app.post('/api/confirmar-pagamento', async (req, res) => {
  const { pagamento_id, usuario_id, usuario_nome, campanha_id, valor } = req.body;
  try {
    await pool.query("UPDATE pagamentos SET status = 'aprovado' WHERE id = $1", [pagamento_id]);

    const { rows } = await pool.query(`
      INSERT INTO lances (campanha_id, usuario_id, usuario_nome, valor, data_hora)
      VALUES ($1, $2, $3, $4, NOW()) RETURNING *
    `, [campanha_id, usuario_id, usuario_nome, valor]);

    // Atualizar data_fim se for o primeiro lance
    await pool.query(`
      UPDATE campanhas 
      SET data_fim = COALESCE(data_fim, NOW() + INTERVAL '1 hour' * duracao_horas), data_inicio = COALESCE(data_inicio, NOW())
      WHERE id = $1 AND data_inicio IS NULL
    `, [campanha_id]);

    // Buscar campanha atualizada
    const camp = await pool.query('SELECT * FROM campanhas WHERE id = $1', [campanha_id]);

    io.emit('novo-lance', {
      lance: rows[0],
      campanha: camp.rows[0]
    });

    res.json({ sucesso: true, lance: rows[0] });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ============================================================
// SOCKET.IO
// ============================================================

io.on('connection', (socket) => {
  console.log('[SOCKET] Cliente conectado:', socket.id);
  socket.on('join-campanha', (campanhaId) => {
    socket.join(`campanha-${campanhaId}`);
  });
  socket.on('disconnect', () => {
    console.log('[SOCKET] Cliente desconectado:', socket.id);
  });
});

// Timer automático: finaliza campanhas expiradas
setInterval(async () => {
  try {
    await pool.query(`
      UPDATE campanhas SET status = 'finalizada'
      WHERE status = 'ativa' AND data_fim IS NOT NULL AND data_fim < NOW()
    `);
  } catch (e) { console.error('[TIMER]', e); }
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[SERVER] Rodando na porta ${PORT}`));

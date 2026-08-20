const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

async function queryWithRetry(sql, params = [], tentativas = 3) {
  for (let i = 0; i < tentativas; i++) {
    try {
      return await pool.query(sql, params);
    } catch (err) {
      if (i === tentativas - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function queryAll(sql, params) {
  const res = await queryWithRetry(sql, params);
  return res.rows;
}

async function queryOne(sql, params) {
  const rows = await queryAll(sql, params);
  return rows[0] || null;
}

async function queryExec(sql, params) {
  const res = await queryWithRetry(sql, params);
  return res;
}

// ========== CAMPANHAS (LEILÕES) ==========
async function listarCampanhas() {
  return queryAll(`SELECT * FROM campanhas ORDER BY id DESC`);
}

async function buscarCampanhaPorId(id) {
  return queryOne(`SELECT * FROM campanhas WHERE id = $1`, [id]);
}

async function buscarCampanhaPorSlug(slug) {
  return queryOne(`SELECT * FROM campanhas WHERE slug = $1`, [slug]);
}

async function criarCampanha(dados) {
  const sql = `INSERT INTO campanhas 
    (nome, slug, descricao, premio_imagem, premio_imagem_url, meta_valor, lance_inicial, 
     duracao_horas, status, influencer_id, data_inicio, data_fim)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING *`;
  const params = [
    dados.nome, dados.slug, dados.descricao || '', dados.premio_imagem || '',
    dados.premio_imagem_url || '', dados.meta_valor || 3.00, dados.lance_inicial || 0.01,
    dados.duracao_horas || 24, dados.status || 'pendente', dados.influencer_id || null,
    dados.data_inicio || null, dados.data_fim || null
  ];
  const res = await queryExec(sql, params);
  return res.rows[0];
}

async function atualizarCampanha(id, dados) {
  const campos = [];
  const vals = [];
  let idx = 1;
  const mapeamento = {
    nome: 'nome', slug: 'slug', descricao: 'descricao',
    premio_imagem: 'premio_imagem', premio_imagem_url: 'premio_imagem_url',
    meta_valor: 'meta_valor', lance_inicial: 'lance_inicial',
    duracao_horas: 'duracao_horas', status: 'status',
    influencer_id: 'influencer_id', data_inicio: 'data_inicio', data_fim: 'data_fim'
  };
  for (const [key, col] of Object.entries(mapeamento)) {
    if (dados[key] !== undefined) {
      campos.push(`${col} = $${idx++}`);
      vals.push(dados[key]);
    }
  }
  if (campos.length === 0) return buscarCampanhaPorId(id);
  vals.push(id);
  const sql = `UPDATE campanhas SET ${campos.join(', ')} WHERE id = $${idx} RETURNING *`;
  const res = await queryExec(sql, vals);
  return res.rows[0];
}

async function atualizarLance(id, dados) {
  return atualizarCampanha(id, dados);
}

async function deletarCampanha(id) {
  await queryExec(`UPDATE campanhas SET status = 'cancelada' WHERE id = $1`, [id]);
}

async function ativarCampanha(id) {
  const agora = new Date();
  const camp = await buscarCampanhaPorId(id);
  if (!camp) return null;
  const duracao = camp.duracao_horas || 24;
  const fim = new Date(agora.getTime() + duracao * 60 * 60 * 1000);
  const res = await queryExec(
    `UPDATE campanhas SET status = 'ativo', data_inicio = $1, data_fim = $2 WHERE id = $3 RETURNING *`,
    [agora.toISOString(), fim.toISOString(), id]
  );
  return res.rows[0];
}

async function pausarCampanha(id) {
  const res = await queryExec(
    `UPDATE campanhas SET status = 'pausado' WHERE id = $1 RETURNING *`, [id]
  );
  return res.rows[0];
}

async function finalizarCampanha(id) {
  const res = await queryExec(
    `UPDATE campanhas SET status = 'finalizado', data_fim = $1 WHERE id = $2 RETURNING *`,
    [new Date().toISOString(), id]
  );
  return res.rows[0];
}

// ========== USUÁRIOS (PARTICIPANTES) ==========
async function buscarOuCriarUsuario(nome, email) {
  let user = await queryOne(`SELECT * FROM usuarios WHERE email = $1`, [email]);
  if (user) {
    if (nome && user.nome !== nome) {
      await queryExec(`UPDATE usuarios SET nome = $1 WHERE id = $2`, [nome, user.id]);
      user.nome = nome;
    }
    return user;
  }
  const res = await queryExec(
    `INSERT INTO usuarios (nome, email) VALUES ($1, $2) RETURNING *`,
    [nome, email]
  );
  return res.rows[0];
}

async function buscarUsuarioPorId(id) {
  return queryOne(`SELECT * FROM usuarios WHERE id = $1`, [id]);
}

async function listarUsuarios() {
  return queryAll(`SELECT * FROM usuarios ORDER BY id DESC`);
}

// ========== LANCES ==========
async function registrarLance(campanha_id, usuario_id, usuario_nome, valor) {
  const res = await queryExec(
    `INSERT INTO lances (campanha_id, usuario_id, usuario_nome, valor, data_hora)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [campanha_id, usuario_id, usuario_nome, valor, new Date().toISOString()]
  );
  return res.rows[0];
}

async function buscarLancesPorCampanha(campanha_id, limit = 50) {
  return queryAll(
    `SELECT * FROM lances WHERE campanha_id = $1 ORDER BY data_hora DESC LIMIT $2`,
    [campanha_id, limit]
  );
}

async function buscarUltimoLance(campanha_id) {
  return queryOne(
    `SELECT * FROM lances WHERE campanha_id = $1 ORDER BY data_hora DESC LIMIT 1`,
    [campanha_id]
  );
}

async function contarLancesPorCampanha(campanha_id) {
  const res = await queryExec(
    `SELECT COUNT(*) as total FROM lances WHERE campanha_id = $1`, [campanha_id]
  );
  return parseInt(res.rows[0].total, 10);
}

async function buscarRankingMaiorLance(campanha_id) {
  return queryAll(`
    SELECT usuario_nome as usuario, MAX(valor) as valor, COUNT(*) as lances, SUM(valor) as total_investido
    FROM lances WHERE campanha_id = $1
    GROUP BY usuario_nome ORDER BY valor DESC LIMIT 10
  `, [campanha_id]);
}

async function buscarRankingMaisLances(campanha_id) {
  return queryAll(`
    SELECT usuario_nome as usuario, MAX(valor) as valor, COUNT(*) as lances, SUM(valor) as total_investido
    FROM lances WHERE campanha_id = $1
    GROUP BY usuario_nome ORDER BY lances DESC LIMIT 10
  `, [campanha_id]);
}

async function buscarRankingMenosLances(campanha_id) {
  return queryAll(`
    SELECT usuario_nome as usuario, MAX(valor) as valor, COUNT(*) as lances, SUM(valor) as total_investido
    FROM lances WHERE campanha_id = $1
    GROUP BY usuario_nome ORDER BY lances ASC LIMIT 10
  `, [campanha_id]);
}

async function buscarLancesPorUsuario(campanha_id, usuario_nome) {
  return queryAll(
    `SELECT * FROM lances WHERE campanha_id = $1 AND usuario_nome = $2 ORDER BY data_hora DESC`,
    [campanha_id, usuario_nome]
  );
}

// ========== PAGAMENTOS ==========
async function criarPagamento(dados) {
  const res = await queryExec(
    `INSERT INTO pagamentos 
     (campanha_id, usuario_id, valor, status, mp_id, transacao_id, pix_qr_code, pix_qr_code_base64, pix_link)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      dados.campanha_id, dados.usuario_id, dados.valor, dados.status || 'pendente',
      dados.mp_id || null, dados.transacao_id || null, dados.pix_qr_code || null,
      dados.pix_qr_code_base64 || null, dados.pix_link || null
    ]
  );
  return res.rows[0];
}

async function buscarPagamentoPorId(id) {
  return queryOne(`SELECT * FROM pagamentos WHERE id = $1`, [id]);
}

async function buscarPagamentoPorTransacao(transacao_id) {
  return queryOne(`SELECT * FROM pagamentos WHERE transacao_id = $1 OR mp_id = $1`, [transacao_id]);
}

async function atualizarPagamentoStatus(id, status, dados = {}) {
  const campos = ['status = $1'];
  const vals = [status];
  let idx = 2;
  if (dados.pix_qr_code) { campos.push(`pix_qr_code = $${idx++}`); vals.push(dados.pix_qr_code); }
  if (dados.pix_qr_code_base64) { campos.push(`pix_qr_code_base64 = $${idx++}`); vals.push(dados.pix_qr_code_base64); }
  if (dados.pix_link) { campos.push(`pix_link = $${idx++}`); vals.push(dados.pix_link); }
  vals.push(id);
  const sql = `UPDATE pagamentos SET ${campos.join(', ')} WHERE id = $${idx} RETURNING *`;
  const res = await queryExec(sql, vals);
  return res.rows[0];
}

async function listarPagamentosPendentes() {
  return queryAll(`SELECT * FROM pagamentos WHERE status = 'pendente' ORDER BY id DESC`);
}

// ========== INFLUENCERS ==========
async function listarInfluencers() {
  return queryAll(`SELECT * FROM influencers ORDER BY id DESC`);
}

async function buscarInfluencerPorId(id) {
  return queryOne(`SELECT * FROM influencers WHERE id = $1`, [id]);
}

async function criarInfluencer(dados) {
  const res = await queryExec(
    `INSERT INTO influencers (nome, email, telefone, codigo, comissao, premio_25, premio_50, premio_75, premio_100)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [dados.nome, dados.email, dados.telefone || '', dados.codigo || '',
     dados.comissao || 0, dados.premio_25 || 0, dados.premio_50 || 0,
     dados.premio_75 || 0, dados.premio_100 || 0]
  );
  return res.rows[0];
}

async function atualizarInfluencer(id, dados) {
  const campos = [];
  const vals = [];
  let idx = 1;
  const map = { nome:'nome', email:'email', telefone:'telefone', codigo:'codigo',
    comissao:'comissao', premio_25:'premio_25', premio_50:'premio_50',
    premio_75:'premio_75', premio_100:'premio_100' };
  for (const [k, col] of Object.entries(map)) {
    if (dados[k] !== undefined) { campos.push(`${col} = $${idx++}`); vals.push(dados[k]); }
  }
  if (campos.length === 0) return buscarInfluencerPorId(id);
  vals.push(id);
  const sql = `UPDATE influencers SET ${campos.join(', ')} WHERE id = $${idx} RETURNING *`;
  const res = await queryExec(sql, vals);
  return res.rows[0];
}

async function deletarInfluencer(id) {
  await queryExec(`DELETE FROM influencers WHERE id = $1`, [id]);
}

// ========== DASHBOARD / ESTATÍSTICAS ==========
async function getDashboardStats() {
  try {
    const totalUsuarios = await safeCount('usuarios');
    const totalCampanhas = await safeCount('campanhas');
    const ativas = await safeCount('campanhas', "status = 'ativo'");
    const totalLances = await safeCount('lances');
    const arrecadado = await safeSum('pagamentos', 'valor', "status = 'confirmado'");
    const pendentes = await safeCount('pagamentos', "status = 'pendente'");
    return {
      total_usuarios: totalUsuarios,
      total_campanhas: totalCampanhas,
      campanhas_ativas: ativas,
      total_lances: totalLances,
      total_arrecadado: arrecadado,
      total_pagamentos_pendentes: pendentes
    };
  } catch (e) {
    console.error('Erro dashboard stats:', e.message);
    return { total_usuarios:0, total_campanhas:0, campanhas_ativas:0, total_lances:0, total_arrecadado:0, total_pagamentos_pendentes:0 };
  }
}

async function safeCount(tabela, where = null) {
  try {
    const sql = where ? `SELECT COUNT(*) as c FROM ${tabela} WHERE ${where}` : `SELECT COUNT(*) as c FROM ${tabela}`;
    const res = await queryExec(sql);
    return parseInt(res.rows[0].c, 10);
  } catch { return 0; }
}

async function safeSum(tabela, coluna, where = null) {
  try {
    const sql = where ? `SELECT COALESCE(SUM(${coluna}),0) as s FROM ${tabela} WHERE ${where}` : `SELECT COALESCE(SUM(${coluna}),0) as s FROM ${tabela}`;
    const res = await queryExec(sql);
    return parseFloat(res.rows[0].s) || 0;
  } catch { return 0; }
}

// ========== CONFIGURAÇÕES ==========
async function buscarConfiguracoes() {
  const row = await queryOne(`SELECT * FROM configuracoes LIMIT 1`);
  if (row) return row;
  const res = await queryExec(`INSERT INTO configuracoes (lance_padrao, duracao_padrao) VALUES (0.01, 24) RETURNING *`);
  return res.rows[0];
}

async function atualizarConfiguracoes(dados) {
  const campos = [];
  const vals = [];
  let idx = 1;
  const map = { lance_padrao:'lance_padrao', duracao_padrao:'duracao_padrao', taxa_pix:'taxa_pix' };
  for (const [k, col] of Object.entries(map)) {
    if (dados[k] !== undefined) { campos.push(`${col} = $${idx++}`); vals.push(dados[k]); }
  }
  if (campos.length === 0) return buscarConfiguracoes();
  const sql = `UPDATE configuracoes SET ${campos.join(', ')} WHERE id = 1 RETURNING *`;
  const res = await queryExec(sql, vals);
  return res.rows[0];
}

// ========== SLUG ==========
async function slugExiste(slug) {
  const res = await queryExec(`SELECT 1 FROM campanhas WHERE slug = $1 LIMIT 1`, [slug]);
  return res.rows.length > 0;
}

// ========== EXPORTAÇÃO ==========
module.exports = {
  pool, queryWithRetry, queryAll, queryOne, queryExec,
  listarCampanhas, buscarCampanhaPorId, buscarCampanhaPorSlug, criarCampanha, atualizarCampanha, atualizarLance,
  deletarCampanha, ativarCampanha, pausarCampanha, finalizarCampanha,
  buscarOuCriarUsuario, buscarUsuarioPorId, listarUsuarios,
  registrarLance, buscarLancesPorCampanha, buscarUltimoLance, contarLancesPorCampanha,
  buscarRankingMaiorLance, buscarRankingMaisLances, buscarRankingMenosLances, buscarLancesPorUsuario,
  criarPagamento, buscarPagamentoPorId, buscarPagamentoPorTransacao, atualizarPagamentoStatus, listarPagamentosPendentes,
  listarInfluencers, buscarInfluencerPorId, criarInfluencer, atualizarInfluencer, deletarInfluencer,
  getDashboardStats, buscarConfiguracoes, atualizarConfiguracoes, slugExiste
};

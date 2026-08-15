/**
 * LEILÃO FÁCIL v2.0 - Módulo de Banco de Dados PostgreSQL
 * Para uso no Render + Supabase
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('Erro inesperado no pool PostgreSQL:', err);
});

// ==========================================
// HELPERS
// ==========================================
async function queryOne(sql, params) {
  const result = await pool.query(sql, params);
  return result.rows[0] || null;
}

async function queryAll(sql, params) {
  const result = await pool.query(sql, params);
  return result.rows;
}

async function queryRun(sql, params) {
  const result = await pool.query(sql, params);
  return { lastInsertRowid: result.rows[0]?.id, changes: result.rowCount };
}

// ==========================================
// FUNÇÕES DE USUÁRIO
// ==========================================
async function criarUsuario(dados) {
  const result = await pool.query(
    'INSERT INTO usuarios (nome, email, telefone, cpf, influencer_ref) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [dados.nome, dados.email || null, dados.telefone || null, dados.cpf || null, dados.influencer_ref || null]
  );
  return { id: result.rows[0].id, ...dados };
}

async function buscarUsuarioPorId(id) {
  return queryOne('SELECT * FROM usuarios WHERE id = $1', [id]);
}

async function buscarUsuarioPorEmail(email) {
  return queryOne('SELECT * FROM usuarios WHERE email = $1', [email]);
}

async function buscarUsuarioPorCPF(cpf) {
  return queryOne('SELECT * FROM usuarios WHERE cpf = $1', [cpf]);
}

async function listarUsuarios(limit = 100, offset = 0) {
  return queryAll('SELECT * FROM usuarios ORDER BY data_cadastro DESC LIMIT $1 OFFSET $2', [limit, offset]);
}

async function atualizarGastosUsuario(usuarioId) {
  const result = await pool.query(
    'SELECT COALESCE(SUM(valor), 0) as total_gasto, COUNT(*) as total_lances FROM lances WHERE usuario_id = $1 AND status = $2',
    [usuarioId, 'confirmado']
  );
  const { total_gasto, total_lances } = result.rows[0];
  await pool.query(
    'UPDATE usuarios SET total_gasto = $1, total_lances = $2 WHERE id = $3',
    [total_gasto, total_lances, usuarioId]
  );
  return result.rows[0];
}

// ==========================================
// FUNÇÕES DE INFLUENCER
// ==========================================
async function criarInfluencer(dados) {
  const result = await pool.query(
    'INSERT INTO influencers (nome, email, codigo_ref, comissao_percentual, pix_chave) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [dados.nome, dados.email, dados.codigo_ref, dados.comissao_percentual || 10, dados.pix_chave || null]
  );
  return { id: result.rows[0].id, ...dados };
}

async function buscarInfluencerPorCodigo(codigo) {
  return queryOne('SELECT * FROM influencers WHERE codigo_ref = $1 AND ativo = 1', [codigo]);
}

async function buscarInfluencerPorId(id) {
  return queryOne('SELECT * FROM influencers WHERE id = $1', [id]);
}

async function listarInfluencers() {
  return queryAll('SELECT * FROM influencers ORDER BY data_cadastro DESC');
}

async function atualizarEstatisticasInfluencer(influencerId) {
  const result = await pool.query(
    `SELECT 
      COUNT(DISTINCT CASE WHEN tipo_evento = 'clique' THEN id END) as total_cliques,
      COUNT(DISTINCT CASE WHEN tipo_evento = 'conversao' THEN id END) as total_conversoes,
      COALESCE(SUM(CASE WHEN tipo_evento = 'conversao' THEN valor_evento END), 0) as total_gerado,
      COALESCE(SUM(comissao_gerada), 0) as total_comissao
    FROM tracking_influencer WHERE influencer_id = $1`,
    [influencerId]
  );
  const stats = result.rows[0];
  await pool.query(
    'UPDATE influencers SET total_cliques = $1, total_conversoes = $2, total_gerado = $3, total_comissao = $4 WHERE id = $5',
    [stats.total_cliques, stats.total_conversoes, stats.total_gerado, stats.total_comissao, influencerId]
  );
  return stats;
}

async function registrarEventoInfluencer(dados) {
  await pool.query(
    'INSERT INTO tracking_influencer (influencer_id, campanha_id, usuario_id, tipo_evento, valor_evento, comissao_gerada, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [
      dados.influencer_id, dados.campanha_id || null, dados.usuario_id || null,
      dados.tipo_evento, dados.valor_evento || 0, dados.comissao_gerada || 0,
      dados.ip_address || null, dados.user_agent || null
    ]
  );
  return { changes: 1 };
}

// ==========================================
// FUNÇÕES DE CAMPANHA
// ==========================================
async function criarCampanha(dados) {
  const now = new Date();
  const dataFim = new Date(now.getTime() + (dados.duracao_horas || 24) * 60 * 60 * 1000);

  const result = await pool.query(
    `INSERT INTO campanhas 
    (nome, slug, descricao, status, data_inicio, data_fim, duracao_horas,
     lance_inicial, lance_minimo, lance_maximo, meta_valor,
     premio_nome, premio_descricao, premio_valor, premio_imagem,
     influencer_id, comissao_ativa)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    RETURNING id`,
    [
      dados.nome, dados.slug, dados.descricao || null,
      dados.status || 'pendente', dados.data_inicio || now.toISOString(),
      dados.data_fim || dataFim.toISOString(), dados.duracao_horas || 24,
      dados.lance_inicial || 0.01, dados.lance_minimo || 0.01,
      dados.lance_maximo || 1.00, dados.meta_valor || 0,
      dados.premio_nome || null, dados.premio_descricao || null,
      dados.premio_valor || null, dados.premio_imagem || null,
      dados.influencer_id || null, dados.comissao_ativa || 0
    ]
  );
  return { id: result.rows[0].id, ...dados };
}

async function buscarCampanhaPorId(id) {
  return queryOne('SELECT * FROM campanhas WHERE id = $1', [id]);
}

async function buscarCampanhaPorSlug(slug) {
  return queryOne('SELECT * FROM campanhas WHERE slug = $1', [slug]);
}

async function buscarCampanhaAtiva() {
  return queryOne("SELECT * FROM campanhas WHERE status = 'ativo' ORDER BY data_inicio DESC LIMIT 1");
}

async function listarCampanhas(status = null) {
  if (status) {
    return queryAll('SELECT * FROM campanhas WHERE status = $1 ORDER BY created_at DESC', [status]);
  }
  return queryAll('SELECT * FROM campanhas ORDER BY created_at DESC');
}

async function listarCampanhasAtivas() {
  return queryAll("SELECT * FROM campanhas WHERE status = 'ativo' ORDER BY data_inicio DESC");
}

async function atualizarCampanha(id, dados) {
  const campos = Object.keys(dados).filter(k => dados[k] !== undefined);
  if (campos.length === 0) return null;

  const sets = campos.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = campos.map(k => dados[k]);
  values.push(id);

  const result = await pool.query(
    `UPDATE campanhas SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length}`,
    values
  );
  return { changes: result.rowCount };
}

async function encerrarCampanha(id) {
  const result = await pool.query("UPDATE campanhas SET status = 'finalizado', data_fim = CURRENT_TIMESTAMP WHERE id = $1", [id]);
  return { changes: result.rowCount };
}

async function pausarCampanha(id) {
  const result = await pool.query("UPDATE campanhas SET status = 'pausado' WHERE id = $1", [id]);
  return { changes: result.rowCount };
}

async function ativarCampanha(id) {
  const now = new Date().toISOString();
  const campanha = await buscarCampanhaPorId(id);
  if (!campanha) return null;

  const dataFim = new Date(Date.now() + campanha.duracao_horas * 60 * 60 * 1000).toISOString();
  const result = await pool.query(
    "UPDATE campanhas SET status = 'ativo', data_inicio = $1, data_fim = $2 WHERE id = $3",
    [now, dataFim, id]
  );
  return { changes: result.rowCount };
}

async function atualizarTotaisCampanha(campanhaId) {
  const result = await pool.query(
    `SELECT 
      COALESCE(SUM(valor), 0) as total_arrecadado,
      COUNT(*) as total_lances,
      COUNT(DISTINCT usuario_id) as total_participantes
    FROM lances WHERE campanha_id = $1 AND status = 'confirmado'`,
    [campanhaId]
  );
  const stats = result.rows[0];
  await pool.query(
    'UPDATE campanhas SET total_arrecadado = $1, total_lances = $2, total_participantes = $3 WHERE id = $4',
    [stats.total_arrecadado, stats.total_lances, stats.total_participantes, campanhaId]
  );
  return stats;
}

// ==========================================
// FUNÇÕES DE ITENS
// ==========================================
async function criarItem(dados) {
  const result = await pool.query(
    'INSERT INTO itens (campanha_id, nome, descricao, imagem, categoria, lance_inicial, lance_minimo) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [
      dados.campanha_id, dados.nome, dados.descricao || null,
      dados.imagem || null, dados.categoria || null,
      dados.lance_inicial || 0.01, dados.lance_minimo || 0.01
    ]
  );
  return { id: result.rows[0].id, ...dados };
}

async function buscarItemPorId(id) {
  return queryOne('SELECT * FROM itens WHERE id = $1', [id]);
}

async function listarItensPorCampanha(campanhaId) {
  return queryAll('SELECT * FROM itens WHERE campanha_id = $1 ORDER BY id', [campanhaId]);
}

async function listarItensAtivos() {
  return queryAll("SELECT * FROM itens WHERE status = 'ativo' ORDER BY id");
}

async function atualizarLanceAtual(itemId, valor, vencedorId = null) {
  if (vencedorId) {
    const result = await pool.query('UPDATE itens SET lance_atual = $1, vencedor_id = $2 WHERE id = $3', [valor, vencedorId, itemId]);
    return { changes: result.rowCount };
  }
  const result = await pool.query('UPDATE itens SET lance_atual = $1 WHERE id = $2', [valor, itemId]);
  return { changes: result.rowCount };
}

async function encerrarItem(id, vencedorId) {
  const result = await pool.query(
    "UPDATE itens SET status = 'encerrado', vencedor_id = $1, data_encerramento = CURRENT_TIMESTAMP WHERE id = $2",
    [vencedorId, id]
  );
  return { changes: result.rowCount };
}

// ==========================================
// FUNÇÕES DE LANCES
// ==========================================
async function criarLance(dados) {
  const result = await pool.query(
    'INSERT INTO lances (item_id, campanha_id, usuario_id, valor, status, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [
      dados.item_id, dados.campanha_id, dados.usuario_id,
      dados.valor, dados.status || 'confirmado',
      dados.ip_address || null, dados.user_agent || null
    ]
  );
  return { id: result.rows[0].id, ...dados };
}

async function buscarLancePorId(id) {
  return queryOne('SELECT * FROM lances WHERE id = $1', [id]);
}

async function listarLancesPorItem(itemId) {
  return queryAll(
    `SELECT l.*, u.nome as usuario_nome 
    FROM lances l 
    JOIN usuarios u ON l.usuario_id = u.id 
    WHERE l.item_id = $1 AND l.status = 'confirmado'
    ORDER BY l.valor DESC, l.data_hora ASC`,
    [itemId]
  );
}

async function listarLancesPorCampanha(campanhaId) {
  return queryAll(
    `SELECT l.*, u.nome as usuario_nome, i.nome as item_nome
    FROM lances l 
    JOIN usuarios u ON l.usuario_id = u.id 
    JOIN itens i ON l.item_id = i.id
    WHERE l.campanha_id = $1 AND l.status = 'confirmado'
    ORDER BY l.data_hora DESC`,
    [campanhaId]
  );
}

async function listarLancesPorUsuario(usuarioId) {
  return queryAll(
    `SELECT l.*, i.nome as item_nome, c.nome as campanha_nome
    FROM lances l 
    JOIN itens i ON l.item_id = i.id
    JOIN campanhas c ON l.campanha_id = c.id
    WHERE l.usuario_id = $1
    ORDER BY l.data_hora DESC`,
    [usuarioId]
  );
}

async function buscarMaiorLance(itemId) {
  return queryOne(
    `SELECT l.*, u.nome as usuario_nome 
    FROM lances l 
    JOIN usuarios u ON l.usuario_id = u.id 
    WHERE l.item_id = $1 AND l.status = 'confirmado'
    ORDER BY l.valor DESC, l.data_hora ASC LIMIT 1`,
    [itemId]
  );
}

async function buscarRankingLances(campanhaId) {
  return queryAll(
    `SELECT 
      u.id, u.nome, u.email,
      COUNT(l.id) as total_lances,
      COALESCE(SUM(l.valor), 0) as total_gasto,
      MAX(l.valor) as maior_lance
    FROM usuarios u
    JOIN lances l ON u.id = l.usuario_id
    WHERE l.campanha_id = $1 AND l.status = 'confirmado'
    GROUP BY u.id
    ORDER BY total_lances DESC`,
    [campanhaId]
  );
}

async function buscarRankingMaiorLance(campanhaId) {
  return queryAll(
    `SELECT 
      u.id, u.nome, u.email,
      MAX(l.valor) as maior_lance,
      COUNT(l.id) as total_lances
    FROM usuarios u
    JOIN lances l ON u.id = l.usuario_id
    WHERE l.campanha_id = $1 AND l.status = 'confirmado'
    GROUP BY u.id
    ORDER BY maior_lance DESC`,
    [campanhaId]
  );
}

async function buscarRankingMenorLance(campanhaId) {
  return queryAll(
    `SELECT 
      u.id, u.nome, u.email,
      MIN(l.valor) as menor_lance,
      COUNT(l.id) as total_lances
    FROM usuarios u
    JOIN lances l ON u.id = l.usuario_id
    WHERE l.campanha_id = $1 AND l.status = 'confirmado'
    GROUP BY u.id
    HAVING COUNT(l.id) >= 1
    ORDER BY menor_lance ASC`,
    [campanhaId]
  );
}

// ==========================================
// FUNÇÕES DE PAGAMENTOS
// ==========================================
async function criarPagamento(dados) {
  const result = await pool.query(
    `INSERT INTO pagamentos 
    (lance_id, usuario_id, item_id, campanha_id, valor, mp_id, qr_code, qr_code_base64, chave_pix, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING id`,
    [
      dados.lance_id || null, dados.usuario_id, dados.item_id || null,
      dados.campanha_id || null, dados.valor, dados.mp_id || null,
      dados.qr_code || null, dados.qr_code_base64 || null,
      dados.chave_pix || null, dados.status || 'pendente'
    ]
  );
  return { id: result.rows[0].id, ...dados };
}

async function buscarPagamentoPorId(id) {
  return queryOne('SELECT * FROM pagamentos WHERE id = $1', [id]);
}

async function buscarPagamentoPorMpId(mpId) {
  return queryOne('SELECT * FROM pagamentos WHERE mp_id = $1', [mpId]);
}

async function atualizarStatusPagamento(id, status, mpStatus = null) {
  const result = await pool.query(
    'UPDATE pagamentos SET status = $1, mp_status = $2, data_atualizacao = CURRENT_TIMESTAMP WHERE id = $3',
    [status, mpStatus, id]
  );
  return { changes: result.rowCount };
}

async function listarPagamentosPendentes() {
  return queryAll("SELECT * FROM pagamentos WHERE status = 'pendente' ORDER BY data_criacao DESC");
}

// ==========================================
// FUNÇÕES DE CONFIGURAÇÃO
// ==========================================
async function getConfig(chave) {
  const result = await pool.query('SELECT valor FROM configuracoes WHERE chave = $1', [chave]);
  return result.rows[0] ? result.rows[0].valor : null;
}

async function setConfig(chave, valor) {
  const result = await pool.query(
    'INSERT INTO configuracoes (chave, valor) VALUES ($1, $2) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor',
    [chave, valor]
  );
  return { changes: result.rowCount };
}

// ==========================================
// DASHBOARD / ESTATÍSTICAS
// ==========================================
async function getDashboardStats() {
  const totalUsuarios = (await pool.query('SELECT COUNT(*) as count FROM usuarios')).rows[0].count;
  const totalCampanhas = (await pool.query('SELECT COUNT(*) as count FROM campanhas')).rows[0].count;
  const campanhasAtivas = (await pool.query("SELECT COUNT(*) as count FROM campanhas WHERE status = 'ativo'")).rows[0].count;
  const totalLances = (await pool.query('SELECT COUNT(*) as count FROM lances WHERE status = $1', ['confirmado'])).rows[0].count;
  const totalArrecadado = (await pool.query('SELECT COALESCE(SUM(valor), 0) as total FROM lances WHERE status = $1', ['confirmado'])).rows[0].total;
  const totalPagamentosPendentes = (await pool.query("SELECT COUNT(*) as count FROM pagamentos WHERE status = 'pendente'")).rows[0].count;

  return {
    totalUsuarios: parseInt(totalUsuarios),
    totalCampanhas: parseInt(totalCampanhas),
    campanhasAtivas: parseInt(campanhasAtivas),
    totalLances: parseInt(totalLances),
    totalArrecadado: parseFloat(totalArrecadado),
    totalPagamentosPendentes: parseInt(totalPagamentosPendentes)
  };
}

async function getCampanhaStats(campanhaId) {
  const campanha = await buscarCampanhaPorId(campanhaId);
  if (!campanha) return null;

  const lances = await listarLancesPorCampanha(campanhaId);
  const participantes = (await pool.query(
    'SELECT COUNT(DISTINCT usuario_id) as count FROM lances WHERE campanha_id = $1 AND status = $2',
    [campanhaId, 'confirmado']
  )).rows[0].count;

  const maiorLance = (await pool.query(
    'SELECT MAX(valor) as valor FROM lances WHERE campanha_id = $1 AND status = $2',
    [campanhaId, 'confirmado']
  )).rows[0].valor || 0;

  return {
    ...campanha,
    totalLances: lances.length,
    totalParticipantes: parseInt(participantes),
    maiorLance: parseFloat(maiorLance),
    lances
  };
}

// ==========================================
// INICIALIZAÇÃO
// ==========================================
async function initSchema() {
  console.log('✅ Banco de dados PostgreSQL conectado');
}

initSchema();


// ==========================================
// FUNÇÕES DE EDIÇÃO DE CAMPANHA
// ==========================================
async function atualizarCampanhaCompleta(id, dados) {
  const campos = Object.keys(dados).filter(k => dados[k] !== undefined && k !== 'id');
  if (campos.length === 0) return null;

  const sets = campos.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = campos.map(k => dados[k]);
  values.push(id);

  const result = await pool.query(
    `UPDATE campanhas SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length} RETURNING *`,
    values
  );
  return result.rows[0];
}

async function atualizarSlugCampanha(id, novoSlug) {
  const result = await pool.query(
    'UPDATE campanhas SET slug = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
    [novoSlug, id]
  );
  return result.rows[0];
}

// ==========================================
// FUNÇÕES DE EDIÇÃO DE INFLUENCER
// ==========================================
async function atualizarInfluencer(id, dados) {
  const campos = Object.keys(dados).filter(k => dados[k] !== undefined && k !== 'id');
  if (campos.length === 0) return null;

  const sets = campos.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = campos.map(k => dados[k]);
  values.push(id);

  const result = await pool.query(
    `UPDATE influencers SET ${sets} WHERE id = $${values.length} RETURNING *`,
    values
  );
  return result.rows[0];
}

// ==========================================
// FUNÇÕES DE MILESTONES (METAS)
// ==========================================
async function criarMilestone(dados) {
  const result = await pool.query(
    'INSERT INTO influencer_milestones (influencer_id, campanha_id, percentual, valor_premio) VALUES ($1, $2, $3, $4) RETURNING id',
    [dados.influencer_id, dados.campanha_id, dados.percentual, dados.valor_premio]
  );
  return { id: result.rows[0].id, ...dados };
}

async function buscarMilestonesPorInfluencer(influencerId) {
  return queryAll(
    'SELECT * FROM influencer_milestones WHERE influencer_id = $1 ORDER BY percentual',
    [influencerId]
  );
}

async function buscarMilestonesPorCampanha(campanhaId) {
  return queryAll(
    'SELECT m.*, i.nome as influencer_nome FROM influencer_milestones m JOIN influencers i ON m.influencer_id = i.id WHERE m.campanha_id = $1 ORDER BY m.percentual',
    [campanhaId]
  );
}

async function atualizarStatusMilestone(id, status) {
  const dataField = status === 'atingido' ? 'data_atingido' : status === 'pago' ? 'data_pagamento' : null;
  const sql = dataField 
    ? `UPDATE influencer_milestones SET status = $1, ${dataField} = CURRENT_TIMESTAMP WHERE id = $2`
    : 'UPDATE influencer_milestones SET status = $1 WHERE id = $2';
  const result = await pool.query(sql, [status, id]);
  return { changes: result.rowCount };
}

async function verificarMilestonesCampanha(campanhaId) {
  const campanha = await buscarCampanhaPorId(campanhaId);
  if (!campanha || !campanha.meta_valor || campanha.meta_valor <= 0) return [];

  const percentualAtingido = Math.min(100, ((campanha.total_arrecadado || 0) / campanha.meta_valor) * 100);
  const milestones = [25, 50, 75, 100].filter(p => percentualAtingido >= p);

  const resultado = [];
  for (const pct of milestones) {
    const existentes = await pool.query(
      'SELECT * FROM influencer_milestones WHERE campanha_id = $1 AND percentual = $2',
      [campanhaId, pct]
    );
    resultado.push({
      percentual: pct,
      atingido: percentualAtingido >= pct,
      registros: existentes.rows
    });
  }
  return resultado;
}

// ==========================================
// ACTIVITY LOG (PARA TEMPO REAL)
// ==========================================
async function registrarAtividade(tipo, mensagem, dados = null) {
  const result = await pool.query(
    'INSERT INTO activity_log (tipo, mensagem, dados) VALUES ($1, $2, $3) RETURNING id',
    [tipo, mensagem, dados ? JSON.stringify(dados) : null]
  );
  return { id: result.rows[0].id };
}

async function buscarAtividadesRecentes(limit = 50) {
  return queryAll(
    'SELECT * FROM activity_log ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
}

module.exports = {
  db: pool,
  // Usuários
  criarUsuario, buscarUsuarioPorId, buscarUsuarioPorEmail, buscarUsuarioPorCPF,
  listarUsuarios, atualizarGastosUsuario,
  // Influencers
  criarInfluencer, buscarInfluencerPorCodigo, buscarInfluencerPorId,
  listarInfluencers, atualizarEstatisticasInfluencer, registrarEventoInfluencer,
  // Campanhas
  criarCampanha, buscarCampanhaPorId, buscarCampanhaPorSlug, buscarCampanhaAtiva,
  listarCampanhas, listarCampanhasAtivas, atualizarCampanha,
  encerrarCampanha, pausarCampanha, ativarCampanha, atualizarTotaisCampanha,
  // Itens
  criarItem, buscarItemPorId, listarItensPorCampanha, listarItensAtivos,
  atualizarLanceAtual, encerrarItem,
  // Lances
  criarLance, buscarLancePorId, listarLancesPorItem, listarLancesPorCampanha,
  listarLancesPorUsuario, buscarMaiorLance, buscarRankingLances,
  buscarRankingMaiorLance, buscarRankingMenorLance,
  // Pagamentos
  criarPagamento, buscarPagamentoPorId, buscarPagamentoPorMpId,
  atualizarStatusPagamento, listarPagamentosPendentes,
  // Config
  getConfig, setConfig,
  // Dashboard
  getDashboardStats, getCampanhaStats,
  // Edição
  atualizarCampanhaCompleta, atualizarSlugCampanha,
  atualizarInfluencer,
  // Milestones
  criarMilestone, buscarMilestonesPorInfluencer, buscarMilestonesPorCampanha,
  atualizarStatusMilestone, verificarMilestonesCampanha,
  // Activity Log
  registrarAtividade, buscarAtividadesRecentes
};

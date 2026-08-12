/**
 * LEILÃO FÁCIL v2.0 - Módulo de Banco de Dados
 * SQLite com better-sqlite3 (síncrono, ultra-rápido)
 */

const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'database.sqlite');
const db = new Database(dbPath);

// Ativar WAL mode para melhor performance com concorrência
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ==========================================
// SCHEMA INICIAL
// ==========================================
function initSchema() {
  // Usuários
  db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      email TEXT UNIQUE,
      telefone TEXT,
      cpf TEXT UNIQUE,
      data_cadastro DATETIME DEFAULT CURRENT_TIMESTAMP,
      total_gasto REAL DEFAULT 0,
      total_lances INTEGER DEFAULT 0,
      influencer_ref TEXT,
      ativo INTEGER DEFAULT 1
    )
  `);

  // Influencers
  db.exec(`
    CREATE TABLE IF NOT EXISTS influencers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      codigo_ref TEXT UNIQUE NOT NULL,
      comissao_percentual INTEGER DEFAULT 10,
      total_cliques INTEGER DEFAULT 0,
      total_conversoes INTEGER DEFAULT 0,
      total_gerado REAL DEFAULT 0,
      total_comissao REAL DEFAULT 0,
      pix_chave TEXT,
      ativo INTEGER DEFAULT 1,
      data_cadastro DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Campanhas (Leilões)
  db.exec(`
    CREATE TABLE IF NOT EXISTS campanhas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      descricao TEXT,
      status TEXT DEFAULT 'pendente' CHECK(status IN ('pendente', 'ativo', 'pausado', 'finalizado')),
      data_inicio DATETIME,
      data_fim DATETIME,
      duracao_horas INTEGER DEFAULT 24,
      lance_inicial REAL DEFAULT 0.01,
      lance_minimo REAL DEFAULT 0.01,
      lance_maximo REAL DEFAULT 1.00,
      meta_valor REAL DEFAULT 0,
      premio_imagem TEXT,
      premio_nome TEXT,
      premio_descricao TEXT,
      premio_valor REAL,
      influencer_id INTEGER,
      comissao_ativa INTEGER DEFAULT 0,
      total_arrecadado REAL DEFAULT 0,
      total_lances INTEGER DEFAULT 0,
      total_participantes INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (influencer_id) REFERENCES influencers(id)
    )
  `);

  // Itens dentro da campanha
  db.exec(`
    CREATE TABLE IF NOT EXISTS itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campanha_id INTEGER NOT NULL,
      nome TEXT NOT NULL,
      descricao TEXT,
      imagem TEXT,
      categoria TEXT,
      lance_inicial REAL DEFAULT 0.01,
      lance_atual REAL DEFAULT 0.01,
      lance_minimo REAL DEFAULT 0.01,
      status TEXT DEFAULT 'ativo' CHECK(status IN ('ativo', 'encerrado', 'cancelado')),
      vencedor_id INTEGER,
      data_encerramento DATETIME,
      FOREIGN KEY (campanha_id) REFERENCES campanhas(id) ON DELETE CASCADE,
      FOREIGN KEY (vencedor_id) REFERENCES usuarios(id)
    )
  `);

  // Lances
  db.exec(`
    CREATE TABLE IF NOT EXISTS lances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      campanha_id INTEGER NOT NULL,
      usuario_id INTEGER NOT NULL,
      valor REAL NOT NULL,
      status TEXT DEFAULT 'confirmado' CHECK(status IN ('pendente', 'confirmado', 'cancelado', 'reembolsado')),
      pagamento_id INTEGER,
      data_hora DATETIME DEFAULT CURRENT_TIMESTAMP,
      ip_address TEXT,
      user_agent TEXT,
      FOREIGN KEY (item_id) REFERENCES itens(id),
      FOREIGN KEY (campanha_id) REFERENCES campanhas(id),
      FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    )
  `);

  // Pagamentos (PIX)
  db.exec(`
    CREATE TABLE IF NOT EXISTS pagamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lance_id INTEGER,
      usuario_id INTEGER NOT NULL,
      item_id INTEGER,
      campanha_id INTEGER,
      valor REAL NOT NULL,
      mp_id TEXT,
      mp_status TEXT,
      qr_code TEXT,
      qr_code_base64 TEXT,
      chave_pix TEXT,
      status TEXT DEFAULT 'pendente' CHECK(status IN ('pendente', 'aprovado', 'rejeitado', 'cancelado')),
      data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP,
      data_atualizacao DATETIME,
      FOREIGN KEY (lance_id) REFERENCES lances(id),
      FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    )
  `);

  // Tracking de influencers
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracking_influencer (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      influencer_id INTEGER NOT NULL,
      campanha_id INTEGER,
      usuario_id INTEGER,
      tipo_evento TEXT NOT NULL CHECK(tipo_evento IN ('clique', 'cadastro', 'lance', 'conversao')),
      valor_evento REAL DEFAULT 0,
      comissao_gerada REAL DEFAULT 0,
      ip_address TEXT,
      user_agent TEXT,
      data_hora DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (influencer_id) REFERENCES influencers(id),
      FOREIGN KEY (campanha_id) REFERENCES campanhas(id),
      FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    )
  `);

  // Configurações do sistema
  db.exec(`
    CREATE TABLE IF NOT EXISTS configuracoes (
      chave TEXT PRIMARY KEY,
      valor TEXT,
      descricao TEXT
    )
  `);

  // Inserir configurações padrão
  const defaults = [
    ['lance_inicial_padrao', '0.01', 'Valor inicial padrão do lance'],
    ['lance_minimo_padrao', '0.01', 'Valor mínimo padrão do lance'],
    ['duracao_padrao_horas', '24', 'Duração padrão da campanha em horas'],
    ['comissao_padrao', '10', 'Comissão padrão para influencers em %'],
    ['site_nome', 'Leilão Fácil', 'Nome do site'],
    ['site_url', 'https://leilaofacil.com.br', 'URL do site']
  ];

  const insertConfig = db.prepare('INSERT OR IGNORE INTO configuracoes (chave, valor, descricao) VALUES (?, ?, ?)');
  for (const [chave, valor, desc] of defaults) {
    insertConfig.run(chave, valor, desc);
  }

  console.log('✅ Banco de dados inicializado com sucesso');
}

// ==========================================
// FUNÇÕES DE USUÁRIO
// ==========================================
function criarUsuario(dados) {
  const stmt = db.prepare(`
    INSERT INTO usuarios (nome, email, telefone, cpf, influencer_ref)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(dados.nome, dados.email || null, dados.telefone || null, dados.cpf || null, dados.influencer_ref || null);
  return { id: result.lastInsertRowid, ...dados };
}

function buscarUsuarioPorId(id) {
  return db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
}

function buscarUsuarioPorEmail(email) {
  return db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);
}

function buscarUsuarioPorCPF(cpf) {
  return db.prepare('SELECT * FROM usuarios WHERE cpf = ?').get(cpf);
}

function listarUsuarios(limit = 100, offset = 0) {
  return db.prepare('SELECT * FROM usuarios ORDER BY data_cadastro DESC LIMIT ? OFFSET ?').all(limit, offset);
}

function atualizarGastosUsuario(usuarioId) {
  const result = db.prepare(`
    SELECT COALESCE(SUM(valor), 0) as total_gasto, COUNT(*) as total_lances
    FROM lances WHERE usuario_id = ? AND status = 'confirmado'
  `).get(usuarioId);

  db.prepare('UPDATE usuarios SET total_gasto = ?, total_lances = ? WHERE id = ?')
    .run(result.total_gasto, result.total_lances, usuarioId);

  return result;
}

// ==========================================
// FUNÇÕES DE INFLUENCER
// ==========================================
function criarInfluencer(dados) {
  const stmt = db.prepare(`
    INSERT INTO influencers (nome, email, codigo_ref, comissao_percentual, pix_chave)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(dados.nome, dados.email, dados.codigo_ref, dados.comissao_percentual || 10, dados.pix_chave || null);
  return { id: result.lastInsertRowid, ...dados };
}

function buscarInfluencerPorCodigo(codigo) {
  return db.prepare('SELECT * FROM influencers WHERE codigo_ref = ? AND ativo = 1').get(codigo);
}

function buscarInfluencerPorId(id) {
  return db.prepare('SELECT * FROM influencers WHERE id = ?').get(id);
}

function listarInfluencers() {
  return db.prepare('SELECT * FROM influencers ORDER BY data_cadastro DESC').all();
}

function atualizarEstatisticasInfluencer(influencerId) {
  const stats = db.prepare(`
    SELECT 
      COUNT(DISTINCT CASE WHEN tipo_evento = 'clique' THEN id END) as total_cliques,
      COUNT(DISTINCT CASE WHEN tipo_evento = 'conversao' THEN id END) as total_conversoes,
      COALESCE(SUM(CASE WHEN tipo_evento = 'conversao' THEN valor_evento END), 0) as total_gerado,
      COALESCE(SUM(comissao_gerada), 0) as total_comissao
    FROM tracking_influencer WHERE influencer_id = ?
  `).get(influencerId);

  db.prepare(`
    UPDATE influencers 
    SET total_cliques = ?, total_conversoes = ?, total_gerado = ?, total_comissao = ?
    WHERE id = ?
  `).run(stats.total_cliques, stats.total_conversoes, stats.total_gerado, stats.total_comissao, influencerId);

  return stats;
}

function registrarEventoInfluencer(dados) {
  const stmt = db.prepare(`
    INSERT INTO tracking_influencer 
    (influencer_id, campanha_id, usuario_id, tipo_evento, valor_evento, comissao_gerada, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    dados.influencer_id, dados.campanha_id || null, dados.usuario_id || null,
    dados.tipo_evento, dados.valor_evento || 0, dados.comissao_gerada || 0,
    dados.ip_address || null, dados.user_agent || null
  );
}

// ==========================================
// FUNÇÕES DE CAMPANHA
// ==========================================
function criarCampanha(dados) {
  const stmt = db.prepare(`
    INSERT INTO campanhas 
    (nome, slug, descricao, status, data_inicio, data_fim, duracao_horas,
     lance_inicial, lance_minimo, lance_maximo, meta_valor,
     premio_nome, premio_descricao, premio_valor, premio_imagem,
     influencer_id, comissao_ativa)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date();
  const dataFim = new Date(now.getTime() + (dados.duracao_horas || 24) * 60 * 60 * 1000);

  const result = stmt.run(
    dados.nome,
    dados.slug,
    dados.descricao || null,
    dados.status || 'pendente',
    dados.data_inicio || now.toISOString(),
    dados.data_fim || dataFim.toISOString(),
    dados.duracao_horas || 24,
    dados.lance_inicial || 0.01,
    dados.lance_minimo || 0.01,
    dados.lance_maximo || 1.00,
    dados.meta_valor || 0,
    dados.premio_nome || null,
    dados.premio_descricao || null,
    dados.premio_valor || null,
    dados.premio_imagem || null,
    dados.influencer_id || null,
    dados.comissao_ativa || 0
  );

  return { id: result.lastInsertRowid, ...dados };
}

function buscarCampanhaPorId(id) {
  return db.prepare('SELECT * FROM campanhas WHERE id = ?').get(id);
}

function buscarCampanhaPorSlug(slug) {
  return db.prepare('SELECT * FROM campanhas WHERE slug = ?').get(slug);
}

function buscarCampanhaAtiva() {
  return db.prepare("SELECT * FROM campanhas WHERE status = 'ativo' ORDER BY data_inicio DESC LIMIT 1").get();
}

function listarCampanhas(status = null) {
  if (status) {
    return db.prepare('SELECT * FROM campanhas WHERE status = ? ORDER BY created_at DESC').all(status);
  }
  return db.prepare('SELECT * FROM campanhas ORDER BY created_at DESC').all();
}

function listarCampanhasAtivas() {
  return db.prepare("SELECT * FROM campanhas WHERE status = 'ativo' ORDER BY data_inicio DESC").all();
}

function atualizarCampanha(id, dados) {
  const campos = Object.keys(dados).filter(k => dados[k] !== undefined);
  if (campos.length === 0) return null;

  const sets = campos.map(k => `${k} = ?`).join(', ');
  const values = campos.map(k => dados[k]);
  values.push(id);

  const stmt = db.prepare(`UPDATE campanhas SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
  return stmt.run(...values);
}

function encerrarCampanha(id) {
  return db.prepare("UPDATE campanhas SET status = 'finalizado', data_fim = CURRENT_TIMESTAMP WHERE id = ?").run(id);
}

function pausarCampanha(id) {
  return db.prepare("UPDATE campanhas SET status = 'pausado' WHERE id = ?").run(id);
}

function ativarCampanha(id) {
  const now = new Date().toISOString();
  const campanha = buscarCampanhaPorId(id);
  if (!campanha) return null;

  const dataFim = new Date(Date.now() + campanha.duracao_horas * 60 * 60 * 1000).toISOString();
  return db.prepare("UPDATE campanhas SET status = 'ativo', data_inicio = ?, data_fim = ? WHERE id = ?")
    .run(now, dataFim, id);
}

function atualizarTotaisCampanha(campanhaId) {
  const stats = db.prepare(`
    SELECT 
      COALESCE(SUM(valor), 0) as total_arrecadado,
      COUNT(*) as total_lances,
      COUNT(DISTINCT usuario_id) as total_participantes
    FROM lances WHERE campanha_id = ? AND status = 'confirmado'
  `).get(campanhaId);

  db.prepare(`
    UPDATE campanhas 
    SET total_arrecadado = ?, total_lances = ?, total_participantes = ?
    WHERE id = ?
  `).run(stats.total_arrecadado, stats.total_lances, stats.total_participantes, campanhaId);

  return stats;
}

// ==========================================
// FUNÇÕES DE ITENS
// ==========================================
function criarItem(dados) {
  const stmt = db.prepare(`
    INSERT INTO itens (campanha_id, nome, descricao, imagem, categoria, lance_inicial, lance_minimo)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    dados.campanha_id, dados.nome, dados.descricao || null,
    dados.imagem || null, dados.categoria || null,
    dados.lance_inicial || 0.01, dados.lance_minimo || 0.01
  );
  return { id: result.lastInsertRowid, ...dados };
}

function buscarItemPorId(id) {
  return db.prepare('SELECT * FROM itens WHERE id = ?').get(id);
}

function listarItensPorCampanha(campanhaId) {
  return db.prepare('SELECT * FROM itens WHERE campanha_id = ? ORDER BY id').all(campanhaId);
}

function listarItensAtivos() {
  return db.prepare("SELECT * FROM itens WHERE status = 'ativo' ORDER BY id").all();
}

function atualizarLanceAtual(itemId, valor, vencedorId = null) {
  if (vencedorId) {
    return db.prepare('UPDATE itens SET lance_atual = ?, vencedor_id = ? WHERE id = ?')
      .run(valor, vencedorId, itemId);
  }
  return db.prepare('UPDATE itens SET lance_atual = ? WHERE id = ?').run(valor, itemId);
}

function encerrarItem(id, vencedorId) {
  return db.prepare("UPDATE itens SET status = 'encerrado', vencedor_id = ?, data_encerramento = CURRENT_TIMESTAMP WHERE id = ?")
    .run(vencedorId, id);
}

// ==========================================
// FUNÇÕES DE LANCES
// ==========================================
function criarLance(dados) {
  const stmt = db.prepare(`
    INSERT INTO lances (item_id, campanha_id, usuario_id, valor, status, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    dados.item_id, dados.campanha_id, dados.usuario_id,
    dados.valor, dados.status || 'confirmado',
    dados.ip_address || null, dados.user_agent || null
  );
  return { id: result.lastInsertRowid, ...dados };
}

function buscarLancePorId(id) {
  return db.prepare('SELECT * FROM lances WHERE id = ?').get(id);
}

function listarLancesPorItem(itemId) {
  return db.prepare(`
    SELECT l.*, u.nome as usuario_nome 
    FROM lances l 
    JOIN usuarios u ON l.usuario_id = u.id 
    WHERE l.item_id = ? AND l.status = 'confirmado'
    ORDER BY l.valor DESC, l.data_hora ASC
  `).all(itemId);
}

function listarLancesPorCampanha(campanhaId) {
  return db.prepare(`
    SELECT l.*, u.nome as usuario_nome, i.nome as item_nome
    FROM lances l 
    JOIN usuarios u ON l.usuario_id = u.id 
    JOIN itens i ON l.item_id = i.id
    WHERE l.campanha_id = ? AND l.status = 'confirmado'
    ORDER BY l.data_hora DESC
  `).all(campanhaId);
}

function listarLancesPorUsuario(usuarioId) {
  return db.prepare(`
    SELECT l.*, i.nome as item_nome, c.nome as campanha_nome
    FROM lances l 
    JOIN itens i ON l.item_id = i.id
    JOIN campanhas c ON l.campanha_id = c.id
    WHERE l.usuario_id = ?
    ORDER BY l.data_hora DESC
  `).all(usuarioId);
}

function buscarMaiorLance(itemId) {
  return db.prepare(`
    SELECT l.*, u.nome as usuario_nome 
    FROM lances l 
    JOIN usuarios u ON l.usuario_id = u.id 
    WHERE l.item_id = ? AND l.status = 'confirmado'
    ORDER BY l.valor DESC, l.data_hora ASC LIMIT 1
  `).get(itemId);
}

function buscarRankingLances(campanhaId) {
  return db.prepare(`
    SELECT 
      u.id, u.nome, u.email,
      COUNT(l.id) as total_lances,
      COALESCE(SUM(l.valor), 0) as total_gasto,
      MAX(l.valor) as maior_lance
    FROM usuarios u
    JOIN lances l ON u.id = l.usuario_id
    WHERE l.campanha_id = ? AND l.status = 'confirmado'
    GROUP BY u.id
    ORDER BY total_lances DESC
  `).all(campanhaId);
}

function buscarRankingMaiorLance(campanhaId) {
  return db.prepare(`
    SELECT 
      u.id, u.nome, u.email,
      MAX(l.valor) as maior_lance,
      COUNT(l.id) as total_lances
    FROM usuarios u
    JOIN lances l ON u.id = l.usuario_id
    WHERE l.campanha_id = ? AND l.status = 'confirmado'
    GROUP BY u.id
    ORDER BY maior_lance DESC
  `).all(campanhaId);
}

function buscarRankingMenorLance(campanhaId) {
  return db.prepare(`
    SELECT 
      u.id, u.nome, u.email,
      MIN(l.valor) as menor_lance,
      COUNT(l.id) as total_lances
    FROM usuarios u
    JOIN lances l ON u.id = l.usuario_id
    WHERE l.campanha_id = ? AND l.status = 'confirmado'
    GROUP BY u.id
    HAVING total_lances >= 1
    ORDER BY menor_lance ASC
  `).all(campanhaId);
}

// ==========================================
// FUNÇÕES DE PAGAMENTOS
// ==========================================
function criarPagamento(dados) {
  const stmt = db.prepare(`
    INSERT INTO pagamentos 
    (lance_id, usuario_id, item_id, campanha_id, valor, mp_id, qr_code, qr_code_base64, chave_pix, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    dados.lance_id || null, dados.usuario_id, dados.item_id || null,
    dados.campanha_id || null, dados.valor, dados.mp_id || null,
    dados.qr_code || null, dados.qr_code_base64 || null,
    dados.chave_pix || null, dados.status || 'pendente'
  );
  return { id: result.lastInsertRowid, ...dados };
}

function buscarPagamentoPorId(id) {
  return db.prepare('SELECT * FROM pagamentos WHERE id = ?').get(id);
}

function buscarPagamentoPorMpId(mpId) {
  return db.prepare('SELECT * FROM pagamentos WHERE mp_id = ?').get(mpId);
}

function atualizarStatusPagamento(id, status, mpStatus = null) {
  return db.prepare(`
    UPDATE pagamentos SET status = ?, mp_status = ?, data_atualizacao = CURRENT_TIMESTAMP WHERE id = ?
  `).run(status, mpStatus, id);
}

function listarPagamentosPendentes() {
  return db.prepare("SELECT * FROM pagamentos WHERE status = 'pendente' ORDER BY data_criacao DESC").all();
}

// ==========================================
// FUNÇÕES DE CONFIGURAÇÃO
// ==========================================
function getConfig(chave) {
  const row = db.prepare('SELECT valor FROM configuracoes WHERE chave = ?').get(chave);
  return row ? row.valor : null;
}

function setConfig(chave, valor) {
  return db.prepare('INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES (?, ?)').run(chave, valor);
}

// ==========================================
// DASHBOARD / ESTATÍSTICAS
// ==========================================
function getDashboardStats() {
  const totalUsuarios = db.prepare('SELECT COUNT(*) as count FROM usuarios').get().count;
  const totalCampanhas = db.prepare('SELECT COUNT(*) as count FROM campanhas').get().count;
  const campanhasAtivas = db.prepare("SELECT COUNT(*) as count FROM campanhas WHERE status = 'ativo'").get().count;
  const totalLances = db.prepare('SELECT COUNT(*) as count FROM lances WHERE status = "confirmado"').get().count;
  const totalArrecadado = db.prepare('SELECT COALESCE(SUM(valor), 0) as total FROM lances WHERE status = "confirmado"').get().total;
  const totalPagamentosPendentes = db.prepare("SELECT COUNT(*) as count FROM pagamentos WHERE status = 'pendente'").get().count;

  return {
    totalUsuarios,
    totalCampanhas,
    campanhasAtivas,
    totalLances,
    totalArrecadado,
    totalPagamentosPendentes
  };
}

function getCampanhaStats(campanhaId) {
  const campanha = buscarCampanhaPorId(campanhaId);
  if (!campanha) return null;

  const lances = listarLancesPorCampanha(campanhaId);
  const participantes = db.prepare(`
    SELECT COUNT(DISTINCT usuario_id) as count FROM lances 
    WHERE campanha_id = ? AND status = 'confirmado'
  `).get(campanhaId).count;

  const maiorLance = db.prepare(`
    SELECT MAX(valor) as valor FROM lances WHERE campanha_id = ? AND status = 'confirmado'
  `).get(campanhaId).valor || 0;

  return {
    ...campanha,
    totalLances: lances.length,
    totalParticipantes: participantes,
    maiorLance,
    lances
  };
}

// ==========================================
// INICIALIZAÇÃO
// ==========================================
initSchema();

module.exports = {
  db,
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
  getDashboardStats, getCampanhaStats
};

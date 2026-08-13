-- Schema Leilão Fácil v2.0 - PostgreSQL/Supabase

CREATE TABLE IF NOT EXISTS usuarios (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  email TEXT UNIQUE,
  telefone TEXT,
  cpf TEXT UNIQUE,
  data_cadastro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  total_gasto REAL DEFAULT 0,
  total_lances INTEGER DEFAULT 0,
  influencer_ref TEXT,
  ativo INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS influencers (
  id SERIAL PRIMARY KEY,
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
  data_cadastro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS campanhas (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  descricao TEXT,
  status TEXT DEFAULT 'pendente' CHECK(status IN ('pendente', 'ativo', 'pausado', 'finalizado')),
  data_inicio TIMESTAMP,
  data_fim TIMESTAMP,
  duracao_horas INTEGER DEFAULT 24,
  lance_inicial REAL DEFAULT 0.01,
  lance_minimo REAL DEFAULT 0.01,
  lance_maximo REAL DEFAULT 1.00,
  meta_valor REAL DEFAULT 0,
  premio_imagem TEXT,
  premio_nome TEXT,
  premio_descricao TEXT,
  premio_valor REAL,
  influencer_id INTEGER REFERENCES influencers(id),
  comissao_ativa INTEGER DEFAULT 0,
  total_arrecadado REAL DEFAULT 0,
  total_lances INTEGER DEFAULT 0,
  total_participantes INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS itens (
  id SERIAL PRIMARY KEY,
  campanha_id INTEGER NOT NULL REFERENCES campanhas(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  descricao TEXT,
  imagem TEXT,
  categoria TEXT,
  lance_inicial REAL DEFAULT 0.01,
  lance_atual REAL DEFAULT 0.01,
  lance_minimo REAL DEFAULT 0.01,
  status TEXT DEFAULT 'ativo' CHECK(status IN ('ativo', 'encerrado', 'cancelado')),
  vencedor_id INTEGER REFERENCES usuarios(id),
  data_encerramento TIMESTAMP
);

CREATE TABLE IF NOT EXISTS lances (
  id SERIAL PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES itens(id),
  campanha_id INTEGER NOT NULL REFERENCES campanhas(id),
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  valor REAL NOT NULL,
  status TEXT DEFAULT 'confirmado' CHECK(status IN ('pendente', 'confirmado', 'cancelado', 'reembolsado')),
  pagamento_id INTEGER,
  data_hora TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ip_address TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS pagamentos (
  id SERIAL PRIMARY KEY,
  lance_id INTEGER REFERENCES lances(id),
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  item_id INTEGER,
  campanha_id INTEGER,
  valor REAL NOT NULL,
  mp_id TEXT,
  mp_status TEXT,
  qr_code TEXT,
  qr_code_base64 TEXT,
  chave_pix TEXT,
  status TEXT DEFAULT 'pendente' CHECK(status IN ('pendente', 'aprovado', 'rejeitado', 'cancelado')),
  data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  data_atualizacao TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tracking_influencer (
  id SERIAL PRIMARY KEY,
  influencer_id INTEGER NOT NULL REFERENCES influencers(id),
  campanha_id INTEGER REFERENCES campanhas(id),
  usuario_id INTEGER REFERENCES usuarios(id),
  tipo_evento TEXT NOT NULL CHECK(tipo_evento IN ('clique', 'cadastro', 'lance', 'conversao')),
  valor_evento REAL DEFAULT 0,
  comissao_gerada REAL DEFAULT 0,
  ip_address TEXT,
  user_agent TEXT,
  data_hora TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS configuracoes (
  chave TEXT PRIMARY KEY,
  valor TEXT,
  descricao TEXT
);

-- Configurações padrão
INSERT INTO configuracoes (chave, valor, descricao) VALUES
  ('lance_inicial_padrao', '0.01', 'Valor inicial padrão do lance'),
  ('lance_minimo_padrao', '0.01', 'Valor mínimo padrão do lance'),
  ('duracao_padrao_horas', '24', 'Duração padrão da campanha em horas'),
  ('comissao_padrao', '10', 'Comissão padrão para influencers em %'),
  ('site_nome', 'Leilão Fácil', 'Nome do site'),
  ('site_url', 'https://leilaofacil.com.br', 'URL do site')
ON CONFLICT (chave) DO NOTHING;

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const QRCode = require('qrcode');
const path = require('path');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);

// ========== CONFIGURAÇÕES ==========
const PORT = process.env.PORT || 3000;
const MERCADO_PAGO_ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN || 'APP_USR-6748594610084561-072611-b75a26bd80e196ee7040b30ee7a09fa3-1459269241';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const MAX_DURACAO_MINUTOS = 43200; // 30 DIAS

// ========== SUPABASE ==========
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
let supabase = null;
let useSupabase = false;

if (supabaseUrl && supabaseKey) {
    try {
        supabase = createClient(supabaseUrl, supabaseKey);
        useSupabase = true;
        console.log('✅ Supabase conectado!');
    } catch (e) {
        console.log('⚠️ Erro ao conectar Supabase, usando JSON fallback');
        useSupabase = false;
    }
} else {
    console.log('⚠️ Supabase não configurado, usando JSON fallback');
}

// ========== BANCO DE DADOS JSON (FALLBACK) ==========
const DATA_DIR = './';
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'database.json');

if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ========== MULTER ==========
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, unique + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const types = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        if (types.includes(file.mimetype)) cb(null, true);
        else cb(new Error('Formato não suportado'));
    }
});

// ========== SOCKET.IO ==========
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling'],
    pingTimeout: 30000,
    pingInterval: 15000,
    maxHttpBufferSize: 1e4,
    perMessageDeflate: { threshold: 1024 }
});

// ========== ESTRUTURA DO BANCO ==========
let db = {
    usuarios: [],
    campanhas: [],
    itens: [],
    lances: [],
    pagamentos: [],
    _nextId: { usuarios: 1, campanhas: 1, itens: 1, lances: 1, pagamentos: 1 }
};

// ========== FUNÇÕES DO BANCO ==========
function criarCampanhaPadrao() {
    const now = new Date();
    const fim = new Date(now);
    fim.setDate(fim.getDate() + 7);

    db.campanhas.push({
        id: 1,
        nome: 'Campanha Padrão',
        slug: 'campanha-padrao',
        descricao: 'Leilão de produtos selecionados',
        status: 'ativa',
        meta_valor: 3.00,
        premio_imagem: '🏆',
        premio_imagem_url: '',
        premio_titulo: '🏆 PRÊMIO DO LEILÃO',
        influencer: 'Não informado',
        metas_internas: [
            { meta: 25, premio: 'R$ 100,00' },
            { meta: 50, premio: 'R$ 200,00' },
            { meta: 75, premio: 'R$ 300,00' },
            { meta: 100, premio: 'R$ 500,00' }
        ],
        duracao: 1440,
        created_at: now.toISOString()
    });

    db.itens.push({
        id: 1,
        campanha_id: 1,
        nome: 'Kit Churrasco Luxo',
        descricao: 'Maleta com faca, garfo, pegador e tábua personalizada',
        imagem: '🥩',
        categoria: 'Cozinha',
        lance_inicial: 0.00,
        lance_minimo: 0.00,
        incremento_minimo: 0.01,
        data_fim: fim.toISOString(),
        status: 'ativo',
        started_at: null,
        created_at: now.toISOString()
    });
    db._nextId.itens = 2;
    db._nextId.campanhas = 2;
    saveDB();
    console.log('✅ Banco criado com campanha padrão');
}

async function loadDB() {
    // PRIORIZA SUPABASE
    if (useSupabase) {
        try {
            const [campanhas, itens, usuarios, lances, pagamentos] = await Promise.all([
                supabase.from('campanhas').select('*'),
                supabase.from('itens').select('*'),
                supabase.from('usuarios').select('*'),
                supabase.from('lances').select('*'),
                supabase.from('pagamentos').select('*')
            ]);

            // Verifica se há campanhas e se elas têm itens vinculados
            if (campanhas.data && campanhas.data.length > 0) {
                db.campanhas = campanhas.data;
                db.itens = itens.data || [];
                db.usuarios = usuarios.data || [];
                db.lances = lances.data || [];
                db.pagamentos = pagamentos.data || [];
                console.log(`✅ Dados carregados do Supabase: ${db.campanhas.length} campanhas, ${db.itens.length} itens`);
                
                // Verifica se os itens estão vinculados corretamente
                let itensOrfaos = 0;
                db.itens.forEach(item => {
                    const campanha = db.campanhas.find(c => c.id === item.campanha_id);
                    if (!campanha) itensOrfaos++;
                });
                if (itensOrfaos > 0) {
                    console.log(`⚠️ ATENÇÃO: ${itensOrfaos} itens estão sem campanha vinculada!`);
                }
                return;
            } else {
                console.log('⚠️ Supabase vazio, tentando JSON...');
            }
        } catch (e) {
            console.log('⚠️ Erro no Supabase, usando JSON:', e.message);
        }
    }

    // FALLBACK: JSON
    try {
        if (fs.existsSync(DB_FILE)) {
            const raw = fs.readFileSync(DB_FILE, 'utf8');
            db = JSON.parse(raw);
            console.log(`✅ Banco carregado do JSON: ${db.campanhas.length} campanhas, ${db.itens.length} itens`);
            return;
        }
    } catch (e) {
        console.error('Erro ao carregar DB:', e);
    }

    // Se não tem nada, cria campanha padrão
    criarCampanhaPadrao();
}

async function saveDB() {
    if (useSupabase) {
        try {
            // Salva campanhas
            for (const item of db.campanhas) {
                const { error } = await supabase.from('campanhas').upsert(item);
                if (error) console.error('❌ Erro ao salvar campanha:', error.message);
            }
            // Salva itens
            for (const item of db.itens) {
                const { error } = await supabase.from('itens').upsert(item);
                if (error) console.error('❌ Erro ao salvar item:', error.message);
            }
            // Salva usuários
            for (const item of db.usuarios) {
                await supabase.from('usuarios').upsert(item);
            }
            // Salva lances
            for (const item of db.lances) {
                await supabase.from('lances').upsert(item);
            }
            // Salva pagamentos
            for (const item of db.pagamentos) {
                await supabase.from('pagamentos').upsert(item);
            }
            console.log('✅ Dados salvos no Supabase');
            return;
        } catch (e) {
            console.log('⚠️ Erro ao salvar no Supabase, salvando JSON:', e.message);
        }
    }

    // FALLBACK: JSON
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
        console.log('✅ Dados salvos no JSON');
    } catch (e) {
        console.error('Erro ao salvar DB:', e);
    }
}

function findOne(table, filter) {
    return db[table].find(item => {
        return Object.keys(filter).every(key => item[key] === filter[key]);
    }) || null;
}

function insert(table, data) {
    const id = db._nextId[table] || 1;
    data.id = id;
    db._nextId[table] = id + 1;
    db[table].push(data);
    saveDB();
    return { lastID: id };
}

function update(table, id, data) {
    const index = db[table].findIndex(item => item.id === id);
    if (index !== -1) {
        db[table][index] = { ...db[table][index], ...data };
        saveDB();
        return true;
    }
    return false;
}

// ========== MIDDLEWARES ==========
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static(UPLOAD_DIR));

// ========== ADMIN MIDDLEWARE ==========
const verificarAdmin = (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ erro: 'Acesso negado' });
    const token = auth.split(' ')[1];
    if (token !== ADMIN_PASSWORD) return res.status(401).json({ erro: 'Senha incorreta' });
    next();
};

// ========== FUNÇÃO PIX ==========
async function criarPagamentoPIX(valor, descricao, usuario, item, campanha) {
    try {
        console.log(`💰 Criando PIX: R$ ${valor} para ${usuario.nome}`);
        const descricaoSegura = `Lance ${Date.now()} - ${item.nome} - ${usuario.nome}`;
        const response = await axios.post(
            'https://api.mercadopago.com/v1/payments',
            {
                transaction_amount: parseFloat(valor),
                description: descricaoSegura,
                payment_method_id: 'pix',
                payer: {
                    email: usuario.email,
                    first_name: usuario.nome,
                    identification: { type: 'CPF', number: '00000000000' }
                },
                additional_info: {
                    items: [{
                        id: `lance_${Date.now()}`,
                        title: item.nome,
                        description: `Lance de R$ ${valor.toFixed(2)}`,
                        quantity: 1,
                        unit_price: parseFloat(valor)
                    }]
                },
                metadata: {
                    tipo: 'lance_leilao',
                    item_id: item.id,
                    campanha_id: campanha.id,
                    usuario_id: usuario.id,
                    usuario_nome: usuario.nome,
                    valor_lance: parseFloat(valor)
                },
                date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString()
            },
            {
                headers: {
                    'Authorization': `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json',
                    'X-Idempotency-Key': crypto.randomUUID()
                }
            }
        );
        console.log('✅ Pagamento PIX criado (MP):', response.data.id);
        const pixData = response.data.point_of_interaction?.transaction_data || {};
        const qrCodeText = pixData.qr_code || null;
        const qrCodeBase64 = pixData.qr_code_base64 || null;
        const ticketUrl = pixData.ticket_url || null;
        let qrCodeBase64Final = qrCodeBase64;
        if (!qrCodeBase64Final && qrCodeText) {
            try {
                const qrBuffer = await QRCode.toBuffer(qrCodeText, {
                    errorCorrectionLevel: 'H',
                    margin: 2,
                    width: 300,
                    color: { dark: '#000000', light: '#FFFFFF' }
                });
                qrCodeBase64Final = qrBuffer.toString('base64');
                console.log('✅ QR Code gerado localmente!');
            } catch (qrErr) {
                console.error('❌ Erro ao gerar QR Code local:', qrErr);
            }
        }
        return {
            sucesso: true,
            pagamento: {
                mp_id: response.data.id,
                transacao_id: response.data.id,
                id: response.data.id,
                status: response.data.status,
                pix_qr_code: qrCodeText,
                pix_qr_code_base64: qrCodeBase64Final,
                pix_link: ticketUrl,
                valor: response.data.transaction_amount
            }
        };
    } catch (error) {
        console.error('❌ Erro Mercado Pago:', error.response?.data || error.message);
        return { sucesso: false, erro: error.response?.data?.message || error.message };
    }
}

// ========== ROTA QR CODE ==========
app.post('/api/gerar-qr', async (req, res) => {
    const { texto } = req.body;
    if (!texto) return res.status(400).json({ erro: 'Texto é obrigatório' });
    try {
        const qrBuffer = await QRCode.toBuffer(texto, {
            errorCorrectionLevel: 'H',
            margin: 2,
            width: 300,
            color: { dark: '#000000', light: '#FFFFFF' }
        });
        res.json({ qr_code: qrBuffer.toString('base64') });
    } catch (err) {
        console.error('❌ Erro ao gerar QR Code:', err);
        res.status(500).json({ erro: 'Erro ao gerar QR Code' });
    }
});

// ========== ROTAS DE USUÁRIO ==========
app.post('/api/usuario', (req, res) => {
    const { nome, email } = req.body;
    if (!nome || !email) return res.status(400).json({ erro: 'Nome e email são obrigatórios' });
    let usuario = findOne('usuarios', { nome, email });
    if (!usuario) {
        const result = insert('usuarios', { nome, email, data_cadastro: new Date().toISOString() });
        usuario = { id: result.lastID, nome, email };
    }
    res.json({ sucesso: true, usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email } });
});

// ========== ROTA DE CAMPANHA (PÚBLICA) ==========
app.get('/api/campanha/:slug', (req, res) => {
    try {
        const campanha = findOne('campanhas', { slug: req.params.slug });
        if (!campanha) return res.status(404).json({ erro: 'Campanha não encontrada' });
        const item = db.itens.find(i => i.campanha_id === campanha.id);
        if (!item) return res.json({ campanha, item: null });
        const lances = db.lances.filter(l => l.item_id === item.id && l.status === 'confirmado');
        const maiorLance = lances.length > 0 ? Math.max(...lances.map(l => l.valor)) : item.lance_inicial;
        const encerrado = new Date(item.data_fim) < new Date() || item.status !== 'ativo';
        let ultimoLance = null;
        if (lances.length > 0) {
            const ultimo = lances.reduce((a, b) => a.id > b.id ? a : b);
            const user = findOne('usuarios', { id: ultimo.usuario_id });
            ultimoLance = { usuario: user ? user.nome : 'Anônimo', valor: ultimo.valor, data: ultimo.data_hora };
        }
        let premioImagem = campanha.premio_imagem || '🏆';
        if (campanha.premio_imagem_url && campanha.premio_imagem_url.trim() !== '') {
            premioImagem = campanha.premio_imagem_url;
        }
        const resultado = {
            ...item,
            total_lances: lances.length,
            lance_atual: maiorLance,
            encerrado: encerrado,
            tem_lance_inicial: lances.length > 0,
            started_at: item.started_at,
            meta_valor: campanha.meta_valor || 3.00,
            premio_imagem: premioImagem,
            premio_imagem_url: campanha.premio_imagem_url || '',
            premio_titulo: campanha.premio_titulo || '🏆 PRÊMIO DO LEILÃO',
            ultimo_lance: ultimoLance,
            ultimos_lances: lances.slice(-3).reverse().map(l => {
                const user = findOne('usuarios', { id: l.usuario_id });
                return { nome: user ? user.nome : 'Anônimo', valor: l.valor, data: l.data_hora };
            })
        };
        res.json({ campanha, item: resultado });
    } catch (e) {
        console.error('Erro /api/campanha/:slug:', e);
        res.status(500).json({ erro: 'Erro ao buscar campanha' });
    }
});

// ========== CRIAR PAGAMENTO ==========
app.post('/api/criar-pagamento', async (req, res) => {
    const { item_id, campanha_id, usuario_id, nome, email, valor } = req.body;
    if (!item_id || valor === undefined || valor < 0) {
        return res.status(400).json({ erro: 'Dados inválidos' });
    }
    try {
        let usuario = findOne('usuarios', { id: usuario_id });
        if (!usuario && nome && email) {
            const result = insert('usuarios', { nome, email, data_cadastro: new Date().toISOString() });
            usuario = { id: result.lastID, nome, email };
        }
        if (!usuario) return res.status(400).json({ erro: 'Usuário não identificado' });
        const item = db.itens.find(i => i.id === item_id);
        if (!item) return res.status(404).json({ erro: 'Item não encontrado' });
        if (item.status !== 'ativo') return res.status(400).json({ erro: 'Leilão encerrado' });
        
        const campanha = db.campanhas.find(c => c.id === campanha_id);
        if (!campanha) return res.status(404).json({ erro: 'Campanha não encontrada' });
        
        const lancesItem = db.lances.filter(l => l.item_id === item_id && l.status === 'confirmado');
        const maiorLance = lancesItem.length > 0 ? Math.max(...lancesItem.map(l => l.valor)) : item.lance_inicial;
        const proximoLance = parseFloat((maiorLance + 0.01).toFixed(2));
        if (Math.abs(valor - proximoLance) > 0.0001) {
            return res.status(400).json({
                erro: `O lance deve ser exatamente R$ ${proximoLance.toFixed(2)} (incremento de R$ 0,01)`,
                proximo_lance: proximoLance
            });
        }

        // ===== CORREÇÃO: PRIMEIRO LANCE USA A DURAÇÃO DA CAMPANHA =====
        if (lancesItem.length === 0) {
            const agora = new Date();
            const fim = new Date(agora);
            
            let duracaoMinutos = 1440; // padrão: 24h
            
            if (campanha && campanha.duracao) {
                duracaoMinutos = parseInt(campanha.duracao) || 1440;
            }
            
            if (duracaoMinutos > MAX_DURACAO_MINUTOS) {
                duracaoMinutos = MAX_DURACAO_MINUTOS;
            }
            if (duracaoMinutos < 1) {
                duracaoMinutos = 1;
            }
            
            fim.setMinutes(fim.getMinutes() + duracaoMinutos);
            
            update('itens', item.id, {
                started_at: agora.toISOString(),
                data_fim: fim.toISOString()
            });
            
            item.started_at = agora.toISOString();
            item.data_fim = fim.toISOString();
            
            console.log(`⏱️ Primeiro lance! Duração: ${duracaoMinutos} minutos (${Math.floor(duracaoMinutos/1440)} dias)`);
        }

        const resultado = await criarPagamentoPIX(valor, `Lance - ${item.nome}`, usuario, item, campanha);
        if (!resultado.sucesso) {
            return res.status(500).json({ erro: resultado.erro || 'Erro ao criar pagamento' });
        }
        const pagResult = insert('pagamentos', {
            item_id,
            campanha_id,
            usuario_id: usuario.id,
            valor: parseFloat(valor),
            transacao_id: resultado.pagamento.mp_id,
            mp_id: resultado.pagamento.mp_id,
            status: 'pending',
            pix_link: resultado.pagamento.pix_link,
            pix_qr_code: resultado.pagamento.pix_qr_code,
            pix_qr_code_base64: resultado.pagamento.pix_qr_code_base64 || null,
            data_criacao: new Date().toISOString()
        });
        res.json({
            sucesso: true,
            pagamento: {
                id: pagResult.lastID,
                transacao_id: resultado.pagamento.mp_id,
                mp_id: resultado.pagamento.mp_id,
                pix_link: resultado.pagamento.pix_link,
                pix_qr_code: resultado.pagamento.pix_qr_code,
                pix_qr_code_base64: resultado.pagamento.pix_qr_code_base64 || null,
                valor: parseFloat(valor),
                status: 'pending'
            },
            usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email },
            is_primeiro_lance: lancesItem.length === 0
        });
    } catch (e) {
        console.error('Erro ao criar pagamento:', e);
        res.status(500).json({ erro: 'Erro ao criar pagamento' });
    }
});

// ========== CONSULTAR PAGAMENTO ==========
app.get('/api/consultar-pagamento/:mp_id', async (req, res) => {
    const mp_id = req.params.mp_id;
    try {
        const pagamento = db.pagamentos.find(p => p.mp_id === mp_id || p.transacao_id === mp_id);
        if (pagamento && pagamento.status === 'confirmado') {
            return res.json({ status: 'confirmado', confirmado: true });
        }
        const response = await axios.get(`https://api.mercadopago.com/v1/payments/${mp_id}`, {
            headers: { 'Authorization': `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}` }
        });
        const mpStatus = response.data.status;
        if (mpStatus === 'approved') {
            if (pagamento) {
                update('pagamentos', pagamento.id, { status: 'confirmado' });
                io.emit('pagamento_confirmado', {
                    transacao_id: pagamento.mp_id,
                    pagamento_id: pagamento.id,
                    mp_id: pagamento.mp_id,
                    status: 'confirmado'
                });
            }
            return res.json({ status: 'confirmado', confirmado: true });
        }
        res.json({ status: mpStatus, confirmado: false });
    } catch (err) {
        console.error('❌ [CONSULTA] Erro:', err.response?.data || err.message);
        res.status(500).json({ erro: 'Erro ao consultar pagamento' });
    }
});

// ========== CONFIRMAR PAGAMENTO ==========
app.post('/api/confirmar-pagamento', (req, res) => {
    const { transacao_id } = req.body;
    try {
        const pagamento = db.pagamentos.find(p =>
            p.mp_id === transacao_id || p.transacao_id === transacao_id || p.id === parseInt(transacao_id)
        );
        if (!pagamento) return res.status(404).json({ erro: 'Pagamento não encontrado' });
        if (pagamento.status === 'confirmado') return res.status(400).json({ erro: 'Pagamento já confirmado' });
        const item = db.itens.find(i => i.id === pagamento.item_id);
        if (!item || item.status !== 'ativo') return res.status(400).json({ erro: 'Leilão encerrado' });
        const lancesItem = db.lances.filter(l => l.item_id === pagamento.item_id && l.status === 'confirmado');
        const maiorLanceExistente = lancesItem.length > 0 ? Math.max(...lancesItem.map(l => l.valor)) : 0;
        if (pagamento.valor < maiorLanceExistente) {
            return res.status(400).json({
                erro: 'Este lance não é mais o maior. Faça um novo lance!',
                maior_lance: maiorLanceExistente
            });
        }
        const lanceResult = insert('lances', {
            item_id: pagamento.item_id,
            usuario_id: pagamento.usuario_id,
            valor: pagamento.valor,
            data_hora: new Date().toISOString(),
            status: 'confirmado',
            pagamento_id: pagamento.id
        });
        update('pagamentos', pagamento.id, { status: 'confirmado', data_confirmacao: new Date().toISOString() });
        const usuario = findOne('usuarios', { id: pagamento.usuario_id });
        io.emit('novo_lance', {
            item_id: pagamento.item_id,
            valor: pagamento.valor,
            usuario: usuario ? usuario.nome : 'Anônimo',
            lance_id: lanceResult.lastID
        });
        res.json({
            sucesso: true,
            lance: {
                id: lanceResult.lastID,
                item_id: pagamento.item_id,
                valor: pagamento.valor,
                usuario: usuario ? usuario.nome : 'Anônimo'
            }
        });
    } catch (e) {
        console.error('❌ [CONFIRMAR] Erro:', e);
        res.status(500).json({ erro: 'Erro ao confirmar pagamento' });
    }
});

// ========== RANKING ==========
app.get('/api/ranking/:item_id', (req, res) => {
    try {
        const item_id = parseInt(req.params.item_id);
        const lancesConfirmados = db.lances.filter(l => l.item_id === item_id && l.status === 'confirmado');
        if (lancesConfirmados.length === 0) {
            return res.json({
                item: db.itens.find(i => i.id === item_id)?.nome || 'Item não encontrado',
                total_lances: 0,
                maior_lance: 0,
                vencedor_atual: null,
                lances: []
            });
        }
        const usuariosMap = {};
        lancesConfirmados.forEach(lance => {
            const user = findOne('usuarios', { id: lance.usuario_id });
            const nome = user ? user.nome : 'Anônimo';
            if (!usuariosMap[nome]) {
                usuariosMap[nome] = { usuario: nome, lances: [], total_investido: 0, maior: 0, quantidade: 0 };
            }
            usuariosMap[nome].lances.push(lance);
            usuariosMap[nome].total_investido += lance.valor;
            usuariosMap[nome].quantidade++;
            if (lance.valor > usuariosMap[nome].maior) {
                usuariosMap[nome].maior = lance.valor;
            }
        });
        let usuariosArray = Object.values(usuariosMap).map(u => {
            const ultimoLance = u.lances.reduce((a, b) => a.id > b.id ? a : b);
            return {
                usuario: u.usuario,
                maior_lance: u.maior,
                total_investido: u.total_investido,
                quantidade_lances: u.quantidade,
                ultimo_valor: ultimoLance.valor,
                ultimo_lance_id: ultimoLance.id,
                data_ultimo_lance: ultimoLance.data_hora,
                maior_lance_ordenacao: u.maior,
                quantidade_ordenacao: u.quantidade
            };
        });
        const rankingMaiorLance = [...usuariosArray]
            .sort((a, b) => b.maior_lance - a.maior_lance)
            .slice(0, 10)
            .map((u, index) => ({
                posicao: index + 1,
                usuario: u.usuario,
                valor: u.maior_lance,
                total_investido: u.total_investido,
                lances: u.quantidade_lances,
                data_hora: u.data_ultimo_lance,
                ultimo_valor: u.ultimo_valor,
                is_vencedor: index === 0
            }));
        const rankingMaisLances = [...usuariosArray]
            .sort((a, b) => b.quantidade_lances - a.quantidade_lances)
            .slice(0, 10)
            .map((u, index) => ({
                posicao: index + 1,
                usuario: u.usuario,
                valor: u.maior_lance,
                total_investido: u.total_investido,
                lances: u.quantidade_lances,
                data_hora: u.data_ultimo_lance,
                ultimo_valor: u.ultimo_valor,
                is_vencedor: u.maior_lance === rankingMaiorLance[0]?.valor && u.usuario === rankingMaiorLance[0]?.usuario
            }));
        const rankingMenosLances = [...usuariosArray]
            .filter(u => u.quantidade_lances > 0)
            .sort((a, b) => a.quantidade_lances - b.quantidade_lances)
            .slice(0, 10)
            .map((u, index) => ({
                posicao: index + 1,
                usuario: u.usuario,
                valor: u.maior_lance,
                total_investido: u.total_investido,
                lances: u.quantidade_lances,
                data_hora: u.data_ultimo_lance,
                ultimo_valor: u.ultimo_valor,
                is_vencedor: u.maior_lance === rankingMaiorLance[0]?.valor && u.usuario === rankingMaiorLance[0]?.usuario
            }));
        res.json({
            item: db.itens.find(i => i.id === item_id)?.nome || 'Item não encontrado',
            total_lances: lancesConfirmados.length,
            maior_lance: rankingMaiorLance.length > 0 ? rankingMaiorLance[0].valor : 0,
            vencedor_atual: rankingMaiorLance.length > 0 ? rankingMaiorLance[0] : null,
            ranking_maior_lance: rankingMaiorLance,
            ranking_mais_lances: rankingMaisLances,
            ranking_menos_lances: rankingMenosLances,
            lances: rankingMaiorLance
        });
    } catch (e) {
        console.error('Erro ao buscar ranking:', e);
        res.status(500).json({ erro: 'Erro ao buscar ranking' });
    }
});

// ========== ADMIN - VERIFICAR SENHA ==========
app.post('/api/admin/verificar', (req, res) => {
    const { senha } = req.body;
    if (senha === ADMIN_PASSWORD) res.json({ sucesso: true });
    else res.status(401).json({ erro: 'Senha incorreta' });
});

// ========== ADMIN - EXPORTAR DADOS ==========
app.get('/api/admin/exportar-dados', verificarAdmin, (req, res) => {
    res.json(db);
});

// ========== ADMIN - CRIAR CAMPANHA (CORRIGIDO) ==========
app.post('/api/admin/criar-campanha', verificarAdmin, upload.single('premio_imagem'), (req, res) => {
    const { 
        nome, descricao, slug, 
        item_nome, item_descricao, item_categoria, 
        data_fim, meta_valor, premio_imagem_url,
        premio_titulo, influencer, metas_internas,
        duracao
    } = req.body;
    
    if (!nome || !slug || !item_nome) {
        return res.status(400).json({ erro: 'Nome, slug e nome do item são obrigatórios' });
    }

    if (findOne('campanhas', { slug })) {
        return res.status(400).json({ erro: 'Slug já existe. Escolha outro.' });
    }

    try {
        let premio_imagem = '🏆';
        let premio_imagem_url_final = '';

        if (req.file) {
            premio_imagem = `/uploads/${req.file.filename}`;
            premio_imagem_url_final = '';
            console.log(`📸 Imagem salva: ${premio_imagem}`);
        } else if (premio_imagem_url && premio_imagem_url.trim() !== '') {
            premio_imagem_url_final = premio_imagem_url.trim();
            premio_imagem = '';
            console.log(`🌐 URL da imagem: ${premio_imagem_url_final}`);
        }

        let metasInternasArray = [];
        if (metas_internas) {
            try { metasInternasArray = JSON.parse(metas_internas); } catch (e) {
                metasInternasArray = [
                    { meta: 25, premio: 'R$ 100,00' },
                    { meta: 50, premio: 'R$ 200,00' },
                    { meta: 75, premio: 'R$ 300,00' },
                    { meta: 100, premio: 'R$ 500,00' }
                ];
            }
        } else {
            metasInternasArray = [
                { meta: 25, premio: 'R$ 100,00' },
                { meta: 50, premio: 'R$ 200,00' },
                { meta: 75, premio: 'R$ 300,00' },
                { meta: 100, premio: 'R$ 500,00' }
            ];
        }

        // ===== CRIA A CAMPANHA =====
        const campResult = insert('campanhas', {
            nome,
            descricao: descricao || '',
            slug,
            status: 'ativa',
            meta_valor: parseFloat(meta_valor) || 3.00,
            premio_imagem,
            premio_imagem_url: premio_imagem_url_final,
            premio_titulo: premio_titulo || '🏆 PRÊMIO DO LEILÃO',
            influencer: influencer || 'Não informado',
            metas_internas: metasInternasArray,
            duracao: parseInt(duracao) || 1440,
            created_at: new Date().toISOString()
        });

        console.log(`✅ Campanha criada com ID: ${campResult.lastID}`);

        // ===== CRIA O ITEM VINCULADO À CAMPANHA =====
        let dataFim = data_fim;
        if (!dataFim && duracao) {
            const agora = new Date();
            const fim = new Date(agora);
            let duracaoMinutos = parseInt(duracao) || 1440;
            if (duracaoMinutos > MAX_DURACAO_MINUTOS) duracaoMinutos = MAX_DURACAO_MINUTOS;
            if (duracaoMinutos < 1) duracaoMinutos = 1;
            fim.setMinutes(fim.getMinutes() + duracaoMinutos);
            dataFim = fim.toISOString();
            console.log(`⏱️ Duração configurada: ${duracaoMinutos} minutos`);
        } else if (!dataFim) {
            const agora = new Date();
            const fim = new Date(agora);
            fim.setHours(fim.getHours() + 24);
            dataFim = fim.toISOString();
        }

        const itemResult = insert('itens', {
            campanha_id: campResult.lastID, // ← GARANTE QUE O ID DA CAMPANHA SEJA SALVO!
            nome: item_nome,
            descricao: item_descricao || '',
            imagem: '📦',
            categoria: item_categoria || 'Geral',
            lance_inicial: 0.00,
            lance_minimo: 0.00,
            incremento_minimo: 0.01,
            data_fim: dataFim,
            status: 'ativo',
            started_at: null,
            created_at: new Date().toISOString()
        });

        console.log(`✅ Item criado com ID: ${itemResult.lastID}, vinculado à campanha ${campResult.lastID}`);

        const url = `https://${process.env.APP_NAME || 'leilao-facil'}.onrender.com/${slug}`;

        res.json({
            sucesso: true,
            campanha: { id: campResult.lastID, nome, slug },
            item: { id: itemResult.lastID, nome: item_nome },
            url
        });
    } catch (e) {
        console.error('Erro ao criar campanha:', e);
        res.status(500).json({ erro: 'Erro ao criar campanha' });
    }
});

// ========== ADMIN - EDITAR CAMPANHA ==========
app.put('/api/admin/campanhas/:id', verificarAdmin, upload.single('premio_imagem'), (req, res) => {
    const id = parseInt(req.params.id);
    const { 
        nome, descricao, meta_valor, premio_imagem_url,
        item_nome, item_descricao, item_categoria,
        duracao, status, premio_titulo, slug,
        influencer, metas_internas
    } = req.body;

    try {
        const campanha = db.campanhas.find(c => c.id === id);
        if (!campanha) return res.status(404).json({ erro: 'Campanha não encontrada' });
        const item = db.itens.find(i => i.campanha_id === id);
        if (!item) return res.status(404).json({ erro: 'Item da campanha não encontrado' });
        
        if (slug && slug !== campanha.slug) {
            const slugExists = db.campanhas.some(c => c.slug === slug && c.id !== id);
            if (slugExists) return res.status(400).json({ erro: 'Este slug já está em uso' });
        }
        
        const campUpdates = {};
        if (nome) campUpdates.nome = nome;
        if (slug) campUpdates.slug = slug;
        if (descricao !== undefined) campUpdates.descricao = descricao;
        if (meta_valor !== undefined) campUpdates.meta_valor = parseFloat(meta_valor);
        if (status) campUpdates.status = status;
        if (premio_titulo !== undefined) campUpdates.premio_titulo = premio_titulo;
        if (influencer !== undefined) campUpdates.influencer = influencer;
        if (duracao !== undefined) campUpdates.duracao = parseInt(duracao) || 1440;
        if (metas_internas) {
            try { campUpdates.metas_internas = JSON.parse(metas_internas); } catch (e) {}
        }
        if (req.file) {
            campUpdates.premio_imagem = `/uploads/${req.file.filename}`;
            campUpdates.premio_imagem_url = '';
        } else if (premio_imagem_url !== undefined) {
            if (premio_imagem_url && premio_imagem_url.trim() !== '') {
                campUpdates.premio_imagem_url = premio_imagem_url.trim();
                campUpdates.premio_imagem = '';
            } else {
                campUpdates.premio_imagem = '🏆';
                campUpdates.premio_imagem_url = '';
            }
        }
        if (Object.keys(campUpdates).length > 0) {
            update('campanhas', id, campUpdates);
        }
        
        const itemUpdates = {};
        if (item_nome) itemUpdates.nome = item_nome;
        if (item_descricao !== undefined) itemUpdates.descricao = item_descricao;
        if (item_categoria) itemUpdates.categoria = item_categoria;
        if (status === 'inativa') itemUpdates.status = 'inativo';
        else if (status === 'ativa') itemUpdates.status = 'ativo';
        
        if (duracao !== undefined && duracao !== null && duracao !== '' && item.started_at) {
            let duracaoMinutos = parseInt(duracao) || 1440;
            if (duracaoMinutos > MAX_DURACAO_MINUTOS) duracaoMinutos = MAX_DURACAO_MINUTOS;
            if (duracaoMinutos < 1) duracaoMinutos = 1;
            const inicio = new Date(item.started_at);
            const novoFim = new Date(inicio);
            novoFim.setMinutes(novoFim.getMinutes() + duracaoMinutos);
            itemUpdates.data_fim = novoFim.toISOString();
            console.log(`⏱️ Duração atualizada: ${duracaoMinutos} minutos, novo fim: ${novoFim.toISOString()}`);
        }
        
        if (Object.keys(itemUpdates).length > 0) {
            update('itens', item.id, itemUpdates);
        }
        
        const novaUrl = `https://${process.env.APP_NAME || 'leilao-facil'}.onrender.com/${slug || campanha.slug}`;
        res.json({ sucesso: true, mensagem: 'Campanha atualizada', url: novaUrl });
    } catch (e) {
        console.error('Erro ao editar campanha:', e);
        res.status(500).json({ erro: 'Erro ao editar campanha' });
    }
});

// ========== ADMIN - LISTAR CAMPANHAS COMPLETAS ==========
app.get('/api/admin/campanhas-completas', verificarAdmin, (req, res) => {
    try {
        const campanhas = db.campanhas.map(campanha => {
            const item = db.itens.find(i => i.campanha_id === campanha.id);
            if (!item) {
                return {
                    ...campanha,
                    item_nome: 'N/A',
                    item_id: null,
                    total_lances: 0,
                    lance_atual: 0,
                    vencedor_atual: null,
                    atingiu_meta: false,
                    percentual_meta: 0,
                    tempo_restante: 0,
                    premio_imagem: campanha.premio_imagem || '🏆',
                    premio_imagem_url: campanha.premio_imagem_url || '',
                    premio_titulo: campanha.premio_titulo || '🏆 PRÊMIO DO LEILÃO',
                    influencer: campanha.influencer || 'Não informado',
                    metas_internas: campanha.metas_internas || [],
                    metas_atingidas: [],
                    url: `https://${process.env.APP_NAME || 'leilao-facil'}.onrender.com/${campanha.slug}`
                };
            }
            const lances = db.lances.filter(l => l.item_id === item.id && l.status === 'confirmado');
            const totalLances = lances.length;
            const maiorLance = lances.length > 0 ? Math.max(...lances.map(l => l.valor)) : 0;
            let vencedorAtual = null;
            if (lances.length > 0) {
                const ultimoLance = lances.reduce((a, b) => a.id > b.id ? a : b);
                const usuario = db.usuarios.find(u => u.id === ultimoLance.usuario_id);
                vencedorAtual = usuario ? { id: usuario.id, nome: usuario.nome } : null;
            }
            const agora = new Date();
            const dataFim = new Date(item.data_fim);
            const tempoRestante = Math.max(0, Math.floor((dataFim - agora) / 1000));
            const metaValor = campanha.meta_valor || 3.00;
            const atingiuMeta = maiorLance >= metaValor;
            const percentualMeta = metaValor > 0 ? Math.min(100, (maiorLance / metaValor) * 100) : 0;
            const status = item.status === 'ativo' ? 'ativa' : 'inativa';
            let premioImagem = campanha.premio_imagem || '🏆';
            if (campanha.premio_imagem_url && campanha.premio_imagem_url.trim() !== '') {
                premioImagem = campanha.premio_imagem_url;
            }
            const metasAtingidas = [];
            if (campanha.metas_internas && campanha.metas_internas.length > 0) {
                campanha.metas_internas.forEach(metaInterna => {
                    if (percentualMeta >= metaInterna.meta) metasAtingidas.push(metaInterna);
                });
            }
            let duracaoDias = 'N/A';
            if (item.started_at && item.data_fim) {
                const inicio = new Date(item.started_at);
                const fim = new Date(item.data_fim);
                const diffMs = fim - inicio;
                const diffDias = diffMs / (1000 * 60 * 60 * 24);
                duracaoDias = Math.round(diffDias);
            }
            return {
                ...campanha,
                status,
                item_id: item.id,
                item_nome: item.nome,
                item_descricao: item.descricao,
                item_imagem: item.imagem,
                total_lances: totalLances,
                lance_atual: maiorLance,
                vencedor_atual: vencedorAtual,
                atingiu_meta: atingiuMeta,
                percentual_meta: percentualMeta,
                meta_valor: metaValor,
                started_at: item.started_at,
                data_fim: item.data_fim,
                tempo_restante: tempoRestante,
                created_at: item.created_at,
                premio_imagem: premioImagem,
                premio_imagem_url: campanha.premio_imagem_url || '',
                premio_titulo: campanha.premio_titulo || '🏆 PRÊMIO DO LEILÃO',
                influencer: campanha.influencer || 'Não informado',
                metas_internas: campanha.metas_internas || [],
                metas_atingidas: metasAtingidas,
                duracao_dias: duracaoDias,
                url: `https://${process.env.APP_NAME || 'leilao-facil'}.onrender.com/${campanha.slug}`
            };
        });
        campanhas.sort((a, b) => b.id - a.id);
        res.json(campanhas);
    } catch (e) {
        console.error('Erro ao buscar campanhas completas:', e);
        res.status(500).json({ erro: 'Erro ao buscar campanhas' });
    }
});

// ========== ADMIN - LISTAR CAMPANHAS ==========
app.get('/api/admin/campanhas', verificarAdmin, (req, res) => {
    res.json(db.campanhas);
});

// ========== ADMIN - LISTAR ITENS ==========
app.get('/api/admin/itens', verificarAdmin, (req, res) => {
    res.json(db.itens);
});

// ========== ADMIN - ALTERAR STATUS DA CAMPANHA ==========
app.put('/api/admin/campanhas/:id/status', verificarAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    const { status } = req.body;
    try {
        const campanha = db.campanhas.find(c => c.id === id);
        if (!campanha) return res.status(404).json({ erro: 'Campanha não encontrada' });
        const item = db.itens.find(i => i.campanha_id === id);
        if (item) {
            update('itens', item.id, { status: status === 'ativa' ? 'ativo' : 'inativo' });
        }
        update('campanhas', id, { status });
        res.json({ sucesso: true, mensagem: `Campanha ${status}` });
    } catch (e) {
        console.error('Erro ao alterar status:', e);
        res.status(500).json({ erro: 'Erro ao alterar status' });
    }
});

// ========== ADMIN - RESETAR LEILÃO ==========
app.post('/api/admin/resetar-leilao/:campanha_id', verificarAdmin, (req, res) => {
    const campanha_id = parseInt(req.params.campanha_id);
    const item = db.itens.find(i => i.campanha_id === campanha_id && i.status === 'ativo');
    if (item) {
        const agora = new Date();
        const fim = new Date(agora);
        fim.setDate(fim.getDate() + 7);
        update('itens', item.id, {
            lance_inicial: 0.00,
            started_at: null,
            data_fim: fim.toISOString()
        });
        db.lances = db.lances.filter(l => l.item_id !== item.id);
        db.pagamentos = db.pagamentos.filter(p => p.item_id !== item.id);
        saveDB();
        res.json({ sucesso: true, mensagem: 'Leilão resetado para R$ 0,00' });
    } else {
        res.status(404).json({ erro: 'Nenhum item ativo encontrado para esta campanha' });
    }
});

// ========== ADMIN - ALTERAR STATUS DO ITEM ==========
app.put('/api/admin/itens/:id', verificarAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    const { status } = req.body;
    update('itens', id, { status });
    res.json({ sucesso: true });
});

// ========== ROTA PARA SERVIR A INDEX DINAMICAMENTE (OPEN GRAPH) ==========
app.get('/:slug', (req, res) => {
    const slug = req.params.slug;
    const campanha = findOne('campanhas', { slug });
    if (!campanha) {
        return res.status(404).send('Campanha não encontrada');
    }
    const ogTitle = campanha.premio_titulo || campanha.nome || 'Leilão Fácil';
    const ogDescription = campanha.descricao || `Participe do leilão ${campanha.nome}! Lances a partir de R$ 0,01.`;
    let ogImage = 'https://leilao-facil.onrender.com/logo-default.jpg';
    if (campanha.premio_imagem_url && campanha.premio_imagem_url.trim() !== '') {
        ogImage = campanha.premio_imagem_url;
    } else if (campanha.premio_imagem && campanha.premio_imagem.startsWith('/uploads/')) {
        ogImage = `https://leilao-facil.onrender.com${campanha.premio_imagem}`;
    }
    const ogUrl = `https://leilao-facil.onrender.com/${slug}`;
    const indexPath = path.join(__dirname, 'public', 'index.html');
    let html = fs.readFileSync(indexPath, 'utf8');
    html = html.replace(/{{OG_TITLE}}/g, ogTitle);
    html = html.replace(/{{OG_DESCRIPTION}}/g, ogDescription);
    html = html.replace(/{{OG_IMAGE}}/g, ogImage);
    html = html.replace(/{{OG_URL}}/g, ogUrl);
    res.send(html);
});

// ========== ROTA RAIZ ==========
app.get('/', (req, res) => {
    res.redirect('/campanha-padrao');
});

// ========== WEBSOCKET ==========
io.on('connection', (socket) => {
    console.log('✅ Cliente conectado:', socket.id);
    socket.on('join_item', (item_id) => {
        socket.join(`item_${item_id}`);
    });
    socket.on('disconnect', () => {
        console.log('❌ Desconectado:', socket.id);
    });
});

// ========== INICIA SERVIDOR ==========
loadDB().then(() => {
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Servidor: http://localhost:${PORT}`);
        console.log(`📁 Arquivos em: ${DATA_DIR}`);
        console.log(`📸 Uploads em: ${UPLOAD_DIR}`);
        console.log(`📦 Itens: ${db.itens.length}`);
        console.log(`👥 Usuários: ${db.usuarios.length}`);
        console.log(`💎 Lances: ${db.lances.length}`);
        console.log(`💳 Pagamentos: ${db.pagamentos.length}`);
        console.log(`📢 Campanhas: ${db.campanhas.length}`);
        console.log(`🔒 Admin: /admin.html (senha: ${ADMIN_PASSWORD})`);
        console.log(`✅ Limite máximo de duração: ${MAX_DURACAO_MINUTOS} minutos (30 dias)`);
        console.log(`✅ CORREÇÃO APLICADA: NUNCA retorna erro de validação de duração`);
        console.log(`✅ Open Graph dinâmico: cada slug tem sua própria thumbnail!`);
        console.log(`✅ Supabase: ${useSupabase ? 'CONECTADO' : 'NÃO CONFIGURADO (usando JSON)'}`);
    });
});
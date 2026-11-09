const express = require('express');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TZ = process.env.TZ_NAME || 'America/Bahia';
const HOUR = process.env.SEND_HOUR || '9';
const FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const DAY = 864e5;

// ---------- banco de dados (arquivo JSON com gravação segura e backup) ----------
function readDB() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    d.users = d.users || {}; d.sessions = d.sessions || {};
    return d;
  } catch (e) { return { users: {}, sessions: {} }; }
}
function writeDB(d) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  if (fs.existsSync(FILE)) fs.copyFileSync(FILE, FILE + '.bak');
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d));
  fs.renameSync(tmp, FILE);
}

// ---------- utilidades ----------
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
function addDays(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function phone(p) {
  let d = String(p).replace(/\D/g, '');
  if (d.length <= 11) d = '55' + d;
  return d;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');


const GEN = 'Olá, {nome}! 😊 Aqui é da {empresa}. Faz um tempinho que não te vemos por aqui e a verdade é que sentimos a sua falta! Já se passaram {dias} dias desde o seu último atendimento, e agora é a hora ideal para cuidar de você de novo. Passa aqui para a gente te receber com todo o carinho. Posso reservar um horário para você? Estamos te esperando! 💚';
const DEFMSG = {
  'Cabeleireiro': 'Olá, {nome}! 💇 Aqui é da {empresa}. Já faz {dias} dias desde o seu último corte, e o cabelo já deve estar pedindo um trato! Sentimos a sua falta por aqui. Passa aqui para renovar o visual, vai ser um prazer te receber de novo. Quer que eu reserve um horário para você? 😊',
  'Barbeiro': 'Fala, {nome}! 💈 Aqui é da {empresa}. Já faz {dias} dias desde o seu último corte e a barba e o cabelo já devem estar pedindo capricho. Sentimos a sua falta! Vem dar aquele talento no visual com a gente. Quer que eu reserve seu horário? 👊',
  'Manicure': 'Olá, {nome}! 💅 Aqui é da {empresa}. Já faz {dias} dias desde o seu último atendimento, é a hora perfeita para renovar as unhas! Sentimos a sua falta por aqui. Vem se cuidar com a gente, vai ser um prazer te receber. Posso reservar um horário? 💖',
  'Dentista': 'Olá, {nome}! 🦷 Aqui é da {empresa}. Já se passaram {dias} dias desde a sua última consulta, e manter o acompanhamento em dia é o melhor para o seu sorriso. Sentimos a sua falta! Posso reservar um horário para você? 😁',
  'Pet shop': 'Olá, {nome}! 🐶 Aqui é da {empresa}. Já faz {dias} dias desde a última visita do seu pet, e ele merece um novo dia de carinho e cuidado! Sentimos saudade dos dois por aqui. Quer que eu reserve um horário? 🐾'
};
function fill(t, c, u, p) {
  return t.replace(/\{nome\}/g, String(c.name).split(' ')[0]).replace(/\{empresa\}/g, u.owner || 'nossa equipe')
    .replace(/\{dias\}/g, c.days).replace(/\{profissao\}/g, p.name);
}
// ---------- WhatsApp (Z-API) ----------
function zapi(u) {
  const s = u.settings || {};
  if (s.instanceId && s.token) return { url: `https://api.z-api.io/instances/${s.instanceId}/token/${s.token}/send-text`, ct: s.clientToken || '' };
  return null;
}
async function sendText(z, ph, message) {
  const r = await fetch(z.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(z.ct ? { 'Client-Token': z.ct } : {}) },
    body: JSON.stringify({ phone: ph, message })
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()));
}

async function runForUser(email) {
  let db = readDB();
  const u = db.users[email];
  if (!u) return { sent: 0, failed: 0 };
  const z = zapi(u);
  if (!z) return { sent: 0, failed: 0, error: 'API do WhatsApp ainda não configurada.' };
  const t = today();
  let sent = 0, failed = 0;
  for (const c of u.clients) {
    const key = c.last + '|' + c.days;
    if (addDays(c.last, c.days) > t || c.sentKey === key) continue;
    const p = u.profs.find(x => x.id === c.profId);
    if (!p) continue;
    const message = fill(p.msg || DEFMSG[p.name] || GEN, c, u, p);
    try {
      await sendText(z, phone(c.phone), message);
      sent++;
      db = readDB();
      const fc = ((db.users[email] || {}).clients || []).find(x => x.id === c.id);
      if (fc) { fc.sentKey = key; writeDB(db); }
      console.log('Enviado para', c.name, '(' + email + ')');
    } catch (e) {
      failed++;
      console.error('Falha ao enviar para', c.name, e.message);
    }
    await sleep(3000);
  }
  return { sent, failed };
}
async function runAll() {
  for (const email of Object.keys(readDB().users)) await runForUser(email);
}

// ---------- servidor ----------
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const fails = {};
const blocked = k => fails[k] && fails[k].n >= 5 && Date.now() - fails[k].t < 600000;
function addFail(k) {
  const f = fails[k] && Date.now() - fails[k].t < 600000 ? fails[k] : { n: 0 };
  f.n++; f.t = Date.now(); fails[k] = f;
}
function newSession(db, email) {
  const now = Date.now();
  for (const k of Object.keys(db.sessions)) if (db.sessions[k].exp < now) delete db.sessions[k];
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { email, exp: now + 30 * DAY };
  writeDB(db);
  return token;
}
const cleanEmail = v => String(v || '').trim().toLowerCase();

app.post('/api/signup', (req, res) => {
  const email = cleanEmail(req.body.email), pw = String(req.body.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'E-mail inválido.' });
  if (pw.length < 6) return res.status(400).json({ error: 'A senha precisa ter pelo menos 6 caracteres.' });
  const db = readDB();
  if (db.users[email]) return res.status(400).json({ error: 'Este e-mail já tem conta. Use a aba Entrar.' });
  const salt = crypto.randomBytes(16).toString('hex');
  db.users[email] = { salt, hash: hashPw(pw, salt), owner: '', profs: [], clients: [], created: Date.now() };
  res.json({ token: newSession(db, email) });
});

app.post('/api/login', (req, res) => {
  const email = cleanEmail(req.body.email), pw = String(req.body.password || '');
  const k = req.ip + '|' + email;
  if (blocked(k)) return res.status(429).json({ error: 'Muitas tentativas. Espere 10 minutos.' });
  const db = readDB();
  const u = db.users[email];
  let ok = false;
  if (u) {
    const a = Buffer.from(hashPw(pw, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
    ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  if (!ok) { addFail(k); return res.status(400).json({ error: 'E-mail ou senha incorretos.' }); }
  delete fails[k];
  res.json({ token: newSession(db, email) });
});

app.use('/api', (req, res, next) => {
  const db = readDB();
  const s = db.sessions[req.get('x-token')];
  if (!s || s.exp < Date.now() || !db.users[s.email]) return res.status(401).json({ error: 'login' });
  req.email = s.email;
  next();
});

app.post('/api/logout', (req, res) => {
  const db = readDB();
  delete db.sessions[req.get('x-token')];
  writeDB(db);
  res.json({ ok: true });
});

app.get('/api/state', (req, res) => {
  const u = readDB().users[req.email];
  res.json({ owner: u.owner, profs: u.profs, clients: u.clients });
});
app.put('/api/state', (req, res) => {
  const db = readDB();
  const u = db.users[req.email];
  const b = req.body || {};
  const clients = Array.isArray(b.clients) ? b.clients : [];
  clients.forEach(c => {
    const o = u.clients.find(x => x.id === c.id);
    if (o && o.sentKey) c.sentKey = o.sentKey; else delete c.sentKey;
  });
  u.owner = String(b.owner || '');
  u.profs = Array.isArray(b.profs) ? b.profs : [];
  u.clients = clients;
  writeDB(db);
  res.json({ ok: true });
});

app.get('/api/settings', (req, res) => {
  const u = readDB().users[req.email];
  const id = (u.settings && u.settings.instanceId) || '';
  res.json({ configured: !!zapi(u), hint: id ? id.slice(0, 4) + '…' : '' });
});
app.put('/api/settings', (req, res) => {
  const m = String(req.body.url || '').match(/instances\/([^/\s]+)\/token\/([^/\s?]+)/);
  if (!m) return res.status(400).json({ error: 'Link inválido. Cole o link completo que termina em /send-text.' });
  const db = readDB();
  db.users[req.email].settings = { instanceId: m[1], token: m[2], clientToken: String(req.body.clientToken || '').trim() };
  writeDB(db);
  res.json({ ok: true });
});
app.post('/api/test', async (req, res) => {
  const z = zapi(readDB().users[req.email]);
  if (!z) return res.json({ error: 'API ainda não configurada.' });
  try {
    await sendText(z, phone(req.body.phone || ''), 'Teste: seu sistema de lembretes Loop está conectado ao WhatsApp. ✅');
    res.json({ ok: true });
  } catch (e) { res.json({ error: e.message }); }
});
app.post('/api/run', async (req, res) => res.json(await runForUser(req.email)));

cron.schedule(`0 ${HOUR} * * *`, () => { runAll().catch(console.error); }, { timezone: TZ });

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Rodando na porta', port, '- envio diário às', HOUR + 'h', TZ));

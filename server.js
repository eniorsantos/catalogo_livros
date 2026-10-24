require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const prod = process.env.NODE_ENV === 'production';
const SECRET = process.env.JWT_SECRET || (prod ? null : 'dev-secret');
if (!SECRET || SECRET === 'troque-isto' && prod) { console.error('Defina JWT_SECRET em produção.'); process.exit(1); }

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

const STATUS = ['quero_ler', 'lendo', 'lido'];
const wrap = (fn) => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'Erro interno' }); });
const pub = ({ cover, user_id, ...b }) => ({ ...b, has_cover: !!cover });

// ---------- auth ----------
const hits = new Map();
const limit = (req, res, next) => {
  const now = Date.now(), a = (hits.get(req.ip) || []).filter(t => now - t < 9e5);
  if (a.length >= 10) return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
  a.push(now); hits.set(req.ip, a); next();
};
const setCookie = (u, res) => res.cookie('token', jwt.sign({ id: u.id, email: u.email }, SECRET, { expiresIn: '7d' }),
  { httpOnly: true, sameSite: 'lax', secure: prod, maxAge: 6048e5 });
const auth = (req, res, next) => {
  const m = /(?:^|;\s*)token=([^;]+)/.exec(req.headers.cookie || '');
  try { req.user = jwt.verify(m?.[1], SECRET); next(); } catch { res.status(401).json({ error: 'Não autenticado' }); }
};

app.post('/api/auth/register', limit, wrap(async (req, res) => {
  if (process.env.ALLOW_REGISTER === 'false') return res.status(403).json({ error: 'Cadastro desativado' });
  const email = String(req.body.email || '').trim().toLowerCase(), pw = String(req.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email) || pw.length < 8) return res.status(400).json({ error: 'Informe um e-mail válido e senha com 8+ caracteres' });
  if (await db.findUser(email)) return res.status(409).json({ error: 'E-mail já cadastrado' });
  const u = await db.createUser(email, await bcrypt.hash(pw, 10));
  setCookie(u, res); res.status(201).json({ email });
}));
app.post('/api/auth/login', limit, wrap(async (req, res) => {
  const u = await db.findUser(String(req.body.email || '').trim().toLowerCase());
  if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) return res.status(401).json({ error: 'Credenciais inválidas' });
  setCookie(u, res); res.json({ email: u.email });
}));
app.post('/api/auth/logout', (_, res) => { res.clearCookie('token'); res.status(204).end(); });
app.get('/api/auth/me', auth, wrap(async (req, res) => {
  const u = await db.findUser(req.user.email);
  res.json({ email: u.email, display_name: u.display_name });
}));
app.put('/api/auth/display-name', auth, wrap(async (req, res) => {
  const { display_name } = req.body || {};
  if (!display_name || display_name.trim().length < 2) return res.status(400).json({ error: 'Nome deve ter pelo menos 2 caracteres' });
  await db.updateUserDisplayName(req.user.email, display_name.trim().slice(0, 100));
  res.json({ ok: true, display_name: display_name.trim() });
}));
app.put('/api/auth/password', auth, wrap(async (req, res) => {
  const { current, new: newPw } = req.body || {};
  if (!current || !newPw || newPw.length < 8) return res.status(400).json({ error: 'Senha atual e nova (mín. 8 chars) são obrigatórias' });
  const u = await db.findUser(req.user.email);
  if (!u || !(await bcrypt.compare(current, u.password_hash))) return res.status(401).json({ error: 'Senha atual incorreta' });
  await db.updateUserPassword(req.user.email, await bcrypt.hash(newPw, 10));
  res.json({ ok: true });
}));
app.delete('/api/auth/account', auth, wrap(async (req, res) => {
  await db.deleteUser(req.user.email);
  res.clearCookie('token');
  res.status(204).end();
}));
app.get('/api/health', (_, res) => res.json({ ok: true, mode: db.mode, databases: db.drivers }));

app.use(['/api/books', '/api/isbn', '/api/sync'], auth);

// ---------- validação ----------
function validate(b, partial = false) {
  const out = {}, errors = [];
  const str = (k, req) => {
    if (b[k] === undefined) { if (req && !partial) errors.push(`${k} é obrigatório`); return; }
    const v = String(b[k] ?? '').trim().slice(0, 2000);
    if (req && !v) errors.push(`${k} é obrigatório`); else out[k] = v || null;
  };
  ['title', 'author'].forEach(k => str(k, true));
  ['isbn', 'genre', 'notes'].forEach(k => str(k, false));
  const int = (k, min, max) => {
    if (b[k] === undefined) return;
    if (b[k] === '' || b[k] === null) { out[k] = null; return; }
    const n = Number(b[k]);
    Number.isInteger(n) && n >= min && n <= max ? out[k] = n : errors.push(`${k} inválido`);
  };
  int('year', 0, new Date().getFullYear() + 1); int('rating', 1, 5);
  if (b.status !== undefined) STATUS.includes(b.status) ? out.status = b.status : errors.push('status inválido');
  else if (!partial) out.status = 'quero_ler';
  if (b.cover !== undefined) {
    if (!b.cover) out.cover = null;
    else if (b.cover.length < 700000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.cover)) out.cover = b.cover;
    else errors.push('capa inválida (máx. ~500 KB)');
  }
  return { out, errors };
}

// ---------- livros ----------
app.get('/api/books', wrap(async (req, res) =>
  res.json(await db.list({ userId: req.user.id, q: req.query.q, status: req.query.status, trash: req.query.trash === '1' }))));
app.get('/api/books/:id', wrap(async (req, res) => {
  const b = await db.get(req.user.id, req.params.id);
  b ? res.json(pub(b)) : res.status(404).json({ error: 'Livro não encontrado' });
}));
app.get('/api/books/:id/cover', wrap(async (req, res) => {
  const b = await db.get(req.user.id, req.params.id);
  const m = /^data:(image\/[\w+]+);base64,(.+)$/.exec(b?.cover || '');
  if (!m) return res.status(404).end();
  res.type(m[1]).set('Cache-Control', 'private, max-age=86400').send(Buffer.from(m[2], 'base64'));
}));
app.post('/api/books', wrap(async (req, res) => {
  const { out, errors } = validate(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  res.status(201).json(pub(await db.create(req.user.id, out)));
}));
app.put('/api/books/:id', wrap(async (req, res) => {
  const { out, errors } = validate(req.body, true);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const b = await db.update(req.user.id, req.params.id, out);
  b ? res.json(pub(b)) : res.status(404).json({ error: 'Livro não encontrado' });
}));
app.delete('/api/books/:id', wrap(async (req, res) => {
  const ok = req.query.permanent === '1' ? await db.purge(req.user.id, req.params.id) : await db.setDeleted(req.user.id, req.params.id, true);
  ok ? res.status(204).end() : res.status(404).json({ error: 'Livro não encontrado' });
}));
app.post('/api/books/:id/restore', wrap(async (req, res) => {
  const b = await db.setDeleted(req.user.id, req.params.id, false);
  b ? res.json(pub(b)) : res.status(404).json({ error: 'Livro não encontrado na lixeira' });
}));

// ---------- importação por ISBN (Open Library) ----------
app.get('/api/isbn/:isbn', wrap(async (req, res) => {
  const isbn = req.params.isbn.replace(/[\s-]/g, '').toUpperCase();
  if (!/^(\d{9}[\dX]|\d{13})$/.test(isbn)) return res.status(400).json({ error: 'ISBN inválido' });
  const opt = { headers: { 'User-Agent': 'book-catalog/2.0' }, signal: AbortSignal.timeout(8000) };
  let d;
  try {
    const r = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`, opt);
    d = (await r.json())[`ISBN:${isbn}`];
  } catch { return res.status(502).json({ error: 'Open Library indisponível' }); }
  if (!d) return res.status(404).json({ error: 'ISBN não encontrado na Open Library' });
  let cover = null;
  const url = d.cover?.medium || d.cover?.large;
  if (url) try {
    const r = await fetch(url, opt), buf = Buffer.from(await r.arrayBuffer());
    if (r.ok && buf.length < 500000) cover = `data:${r.headers.get('content-type') || 'image/jpeg'};base64,${buf.toString('base64')}`;
  } catch {}
  res.json({
    isbn, title: d.title || '', author: (d.authors || []).map(a => a.name).join(', '),
    year: (/\d{4}/.exec(d.publish_date || '') || [])[0] || '', genre: d.subjects?.[0]?.name || '', cover,
  });
}));

app.post('/api/sync', wrap(async (_, res) => {
  try { res.json(await db.sync()); } catch (e) { res.status(400).json({ error: e.message }); }
}));

const port = process.env.PORT || 3000;
db.ready.then(() => app.listen(port, () => console.log(`Catálogo em http://localhost:${port} [modo: ${db.mode}]`)))
  .catch(e => { console.error('Falha ao iniciar o banco:', e.message); process.exit(1); });

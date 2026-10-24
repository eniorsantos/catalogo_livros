const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const T = {
  books: ['id','user_id','title','author','isbn','year','genre','status','rating','notes','cover','created_at','updated_at','deleted_at'],
  users: ['id','email','password_hash','created_at','updated_at'],
};
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL, isbn TEXT, year INTEGER, genre TEXT,
    status TEXT NOT NULL DEFAULT 'quero_ler', rating INTEGER, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
];
// Migração para bancos da v1 (falha silenciosa se a coluna já existe)
const MIGRATIONS = ['user_id', 'cover', 'deleted_at'].map(c => `ALTER TABLE books ADD COLUMN ${c} TEXT`);
const LIST = 'id,title,author,isbn,year,genre,status,rating,notes,created_at,updated_at,deleted_at,(cover IS NOT NULL) AS has_cover';

function sqliteDriver(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new (require('better-sqlite3'))(file);
  db.pragma('journal_mode = WAL');
  return {
    name: 'local',
    all: async (sql, p = []) => db.prepare(sql).all(...p),
    run: async (sql, p = []) => db.prepare(sql).run(...p),
  };
}

function pgDriver(url) {
  const pool = new (require('pg').Pool)({ connectionString: url, ssl: { rejectUnauthorized: false } });
  pool.on('error', e => console.error('PG pool error:', e.message));
  const conv = (s) => { let i = 0; return s.replace(/\?/g, () => '$' + ++i); };
  return {
    name: 'cloud',
    all: async (sql, p = []) => {
      console.log('PG query:', sql, p);
      return (await pool.query(conv(sql), p)).rows;
    },
    run: async (sql, p = []) => {
      console.log('PG exec:', sql, p);
      await pool.query(conv(sql), p);
    },
  };
}

const mode = process.env.DB_MODE || 'local';
const drivers = [];
if (mode !== 'cloud') drivers.push(sqliteDriver(process.env.SQLITE_FILE || './data/books.db'));
if (mode !== 'local') {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL é obrigatório em cloud/hybrid');
  drivers.push(pgDriver(process.env.DATABASE_URL));
}
const primary = drivers[0];
const ready = Promise.all(drivers.map(async d => {
  for (const s of SCHEMA) await d.run(s);
  for (const m of MIGRATIONS) await d.run(m).catch(() => {});
}));

const upsert = (d, t, r) => {
  const c = T[t];
  return d.run(`INSERT INTO ${t} (${c}) VALUES (${c.map(() => '?')})
    ON CONFLICT(id) DO UPDATE SET ${c.slice(1).map(x => `${x}=excluded.${x}`)}`, c.map(k => r[k] ?? null));
};
const writeAll = async (t, r) => { for (const d of drivers) await upsert(d, t, r); };

module.exports = {
  mode,
  drivers: drivers.map(d => d.name),
  ready,

  // ---------- usuários ----------
  async findUser(email) { await ready; return (await primary.all('SELECT * FROM users WHERE email = ?', [email]))[0]; },
  async createUser(email, password_hash) {
    await ready;
    const first = Number((await primary.all('SELECT COUNT(*) AS n FROM users'))[0].n) === 0;
    const now = new Date().toISOString();
    const user = { id: crypto.randomUUID(), email, password_hash, created_at: now, updated_at: now };
    await writeAll('users', user);
    // o primeiro usuário herda os livros criados na v1 (sem dono)
    if (first) for (const d of drivers) await d.run('UPDATE books SET user_id = ? WHERE user_id IS NULL', [user.id]);
    return user;
  },

  // ---------- livros (sempre filtrados por usuário) ----------
  async list({ userId, q, status, trash }) {
    await ready;
    const w = ['user_id = ?', `deleted_at IS ${trash ? 'NOT ' : ''}NULL`], p = [userId];
    if (q) { w.push(`(LOWER(title) LIKE ? OR LOWER(author) LIKE ? OR LOWER(COALESCE(genre,'')) LIKE ?)`); const l = `%${q.toLowerCase()}%`; p.push(l, l, l); }
    if (status) { w.push('status = ?'); p.push(status); }
    return primary.all(`SELECT ${LIST} FROM books WHERE ${w.join(' AND ')} ORDER BY created_at DESC`, p);
  },
  async get(userId, id) { await ready; return (await primary.all('SELECT * FROM books WHERE id = ? AND user_id = ?', [id, userId]))[0]; },
  async create(userId, data) {
    await ready;
    const now = new Date().toISOString();
    const book = { ...data, id: crypto.randomUUID(), user_id: userId, created_at: now, updated_at: now, deleted_at: null };
    await writeAll('books', book);
    return book;
  },
  async update(userId, id, data) {
    const cur = await this.get(userId, id);
    if (!cur || cur.deleted_at) return null;
    const book = { ...cur, ...data, id, user_id: userId, created_at: cur.created_at, updated_at: new Date().toISOString() };
    await writeAll('books', book);
    return book;
  },
  // exclusão lógica: marca deleted_at (propaga na sincronização via updated_at)
  async setDeleted(userId, id, deleted) {
    const cur = await this.get(userId, id);
    if (!cur || !!cur.deleted_at === deleted) return null;
    const now = new Date().toISOString();
    const book = { ...cur, deleted_at: deleted ? now : null, updated_at: now };
    await writeAll('books', book);
    return book;
  },
  // exclusão definitiva: só para itens que já estão na lixeira
  async purge(userId, id) {
    const cur = await this.get(userId, id);
    if (!cur || !cur.deleted_at) return false;
    for (const d of drivers) await d.run('DELETE FROM books WHERE id = ?', [id]);
    return true;
  },

  // Sincroniza local <-> nuvem (livros e usuários): vence o updated_at mais recente.
  async sync() {
    await ready;
    if (drivers.length < 2) throw new Error('Sync exige DB_MODE=hybrid');
    const [a, b] = drivers, res = { toCloud: 0, toLocal: 0 };
    for (const t of Object.keys(T)) {
      const [la, lb] = await Promise.all([a.all(`SELECT * FROM ${t}`), b.all(`SELECT * FROM ${t}`)]);
      const ma = new Map(la.map(x => [x.id, x])), mb = new Map(lb.map(x => [x.id, x]));
      for (const x of la) { const y = mb.get(x.id); if (!y || x.updated_at > y.updated_at) { await upsert(b, t, x); res.toCloud++; } }
      for (const y of lb) { const x = ma.get(y.id); if (!x || y.updated_at > x.updated_at) { await upsert(a, t, y); res.toLocal++; } }
    }
    return res;
  },
};

// HTTP API. Runs as a Netlify Function (netlify/functions/api.js) or locally (dev.js).
// Logins: OWNER_PASSWORD env var = owner (menu, settings); staff PIN set by the owner = staff (orders, billing, rooms, reports).
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { openDb, totals } = require('./db');

const csv = rows => {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = v => {
    if (v == null) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@]/.test(s)) s = "'" + s; // stop Excel treating text as a formula
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n');
};

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const sameSecret = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const hashPin = pin => {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pin, salt, 32).toString('hex');
};
const checkPin = (pin, stored) => {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  return crypto.timingSafeEqual(crypto.scryptSync(String(pin), salt, 32), Buffer.from(hash, 'hex'));
};
const httpError = (status, msg) => Object.assign(new Error(msg), { status });

async function createApp(conn, { serveStatic = false } = {}) {
  const db = await openDb(conn);
  const OWNER = process.env.OWNER_PASSWORD;
  // ponytail: stateless signed cookie; changing SESSION_SECRET logs everyone out (do that after changing the staff PIN)
  const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
  const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
  const DAYS_30 = 30 * 864e5;
  const readRole = req => {
    const m = /(?:^|;\s*)session=([^;]+)/.exec(req.headers.cookie || '');
    if (!m) return null;
    const [role, exp, sig = ''] = m[1].split('.');
    const want = sign(`${role}.${exp}`);
    if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)) || +exp < Date.now()) return null;
    return role;
  };
  const setSession = (req, res, role) => {
    const v = role ? `${role}.${Date.now() + DAYS_30}` : '';
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `session=${v && v + '.' + sign(v)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${role ? DAYS_30 / 1000 : 0}${secure}`);
  };

  const app = express();
  app.use(express.json());
  if (serveStatic) app.use(express.static(path.join(__dirname, 'public')));

  const api = express.Router();
  // Netlify may hand the function either the original /api/... path or its own /.netlify/functions/api/... path
  app.use(['/api', '/.netlify/functions/api'], api);
  const h = fn => async (req, res) => {
    try { res.json(await fn(req, res)); }
    catch (e) { if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' }); }
  };

  api.get('/me', h(req => ({ role: readRole(req), configured: !!OWNER })));
  api.post('/login', h(async (req, res) => {
    if (!OWNER) throw httpError(503, 'Server not set up: OWNER_PASSWORD is missing.');
    const ip = req.headers['x-nf-client-connection-ip'] || req.ip;
    if (await db.loginBlocked(ip)) throw httpError(429, 'Too many wrong attempts. Wait 15 minutes.');
    const secret = String(req.body.secret || '');
    let role = null;
    if (secret && sameSecret(secret, OWNER)) role = 'owner';
    else if (/^\d{6,8}$/.test(secret) && checkPin(secret, (await db.settings()).pin_hash)) role = 'staff';
    if (!role) { await db.loginFailed(ip); throw httpError(401, 'Wrong PIN or password'); }
    await db.loginOk(ip);
    setSession(req, res, role);
    return { role };
  }));
  api.post('/logout', h((req, res) => { setSession(req, res, null); return { ok: true }; }));

  api.use((req, res, next) => {
    req.role = readRole(req);
    req.role ? next() : res.status(401).json({ error: 'Login required' });
  });
  const ownerOnly = (req, res, next) => (req.role === 'owner' ? next() : res.status(403).json({ error: 'Only the owner can do this' }));
  const id = req => +req.params.id;
  const publicSettings = async () => { const { pin_hash, ...s } = await db.settings(); return { ...s, has_pin: !!pin_hash }; };

  api.get('/settings', h(publicSettings));
  api.put('/settings', ownerOnly, h(async req => {
    const { pin } = req.body;
    if (pin && !/^\d{6,8}$/.test(pin)) throw httpError(400, 'Staff PIN must be 6 to 8 digits');
    await db.saveSettings(req.body, pin ? hashPin(pin) : null);
    return publicSettings();
  }));

  api.get('/menu', h(() => db.menu()));
  api.post('/menu', ownerOnly, h(req => db.addMenuItem(req.body)));
  api.put('/menu/:id', ownerOnly, h(req => db.updateMenuItem(id(req), req.body)));

  api.get('/orders', h(() => db.activeOrders()));
  api.get('/orders/:id', h(async req => {
    const o = await db.order(id(req));
    // ?discount=N previews totals before billing; the real discount is validated and saved by /bill
    if (req.query.discount !== undefined && o.status !== 'billed')
      o.totals = totals(o.items, Math.min(Math.max(+req.query.discount || 0, 0), o.totals.subtotal));
    return o;
  }));
  api.post('/orders', h(req => db.createOrder(req.body)));
  api.post('/orders/:id/items', h(req => db.addItems(id(req), req.body.items)));
  api.post('/orders/:id/status', h(req => db.setStatus(id(req), req.body.status, req.body.reason)));
  api.post('/orders/:id/bill', h(req => db.bill(id(req), req.body)));
  api.get('/kots', h(req => db.kots(req.query.after)));

  api.get('/folios', h(() => db.openFolios()));
  api.get('/folios/:id', h(req => db.folio(id(req))));
  api.post('/folios', h(req => db.openFolio(req.body)));
  api.post('/folios/:id/settle', h(req => db.settleFolio(id(req), req.body.mode)));

  api.get('/reports/:name', async (req, res) => {
    const { from, to } = req.query;
    try {
      const rows = await db.report(req.params.name, from, to);
      if (!req.query.csv || !Array.isArray(rows)) return res.json(rows);
      res.type('text/csv').attachment(`${req.params.name}_${from}_${to}.csv`).send(csv(rows));
    } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' }); }
  });

  return app;
}

module.exports = { createApp };

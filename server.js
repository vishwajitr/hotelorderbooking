// HTTP API. Runs as a Netlify Function (netlify/functions/api.js) or locally (dev.js).
// Logins: the owner (password) manages menu, staff and settings; each staff member has a PIN for orders, billing, rooms, reports.
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
  // OWNER_PASSWORD is the starter owner password. Once the owner sets their own in Settings it is stored (hashed) in the
  // database and the starter one stops working, unless RESET_OWNER_PASSWORD=true is set to recover a forgotten password.
  const OWNER = process.env.OWNER_PASSWORD;
  const RESET = process.env.RESET_OWNER_PASSWORD === 'true';
  const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
  const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
  const DAYS_30 = 30 * 864e5;
  const cookie = (req, name) => (new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || '') || [])[1];
  const secure = req => (req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '');

  // Session cookie: role.staffId.expiry.version.signature. A version bump (see db.bumpSessions) signs everyone out.
  async function readUser(req) {
    const [role, uid, exp, ver, sig = ''] = String(cookie(req, 'session') || '').split('.');
    const want = sign(`${role}.${uid}.${exp}.${ver}`);
    if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)) || +exp < Date.now()) return null;
    if (+ver !== await db.sessionVersion()) return null;
    if (role === 'owner') return { role, name: 'Owner' };
    const s = role === 'staff' && await db.staffById(uid);
    return s && s.active ? { role, id: s.id, name: s.name } : null; // switched-off staff are out at once
  }
  async function setSession(req, res, user) {
    const v = user ? `${user.role}.${user.id || 0}.${Date.now() + DAYS_30}.${await db.sessionVersion()}` : '';
    res.append('Set-Cookie', `session=${v && v + '.' + sign(v)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${user ? DAYS_30 / 1000 : 0}${secure(req)}`);
  }
  const ownerMatches = async secret => {
    const { owner_hash } = await db.settings();
    if (owner_hash && !RESET) return checkPin(secret, owner_hash);
    return !!OWNER && sameSecret(secret, OWNER);
  };
  const pinTaken = async (pin, exceptId) => (await db.staffHashes()).some(s => s.id !== exceptId && checkPin(pin, s.pin_hash));

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  if (serveStatic) app.use(express.static(path.join(__dirname, 'public')));

  const api = express.Router();
  // Netlify may hand the function either the original /api/... path or its own /.netlify/functions/api/... path
  app.use(['/api', '/.netlify/functions/api'], api);
  const h = fn => async (req, res) => {
    try { res.json(await fn(req, res)); }
    catch (e) { if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' }); }
  };

  api.get('/me', h(async req => {
    const user = await readUser(req), { owner_hash } = await db.settings();
    return { role: user?.role || null, name: user?.name || null, configured: !!(OWNER || owner_hash),
      starterPassword: user?.role === 'owner' && (!owner_hash || RESET) };
  }));
  api.post('/login', h(async (req, res) => {
    const { owner_hash } = await db.settings();
    if (!OWNER && !owner_hash) throw httpError(503, 'Server not set up: OWNER_PASSWORD is missing.');
    // Lockout is per device (5 wrong tries) with a looser cap per internet address (30), so one person's typos
    // don't lock out every device in the hotel, which usually shares one address.
    let device = cookie(req, 'device');
    if (!/^[a-f0-9]{32}$/.test(device || '')) {
      device = crypto.randomBytes(16).toString('hex');
      res.append('Set-Cookie', `device=${device}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${10 * 365 * 86400}${secure(req)}`);
    }
    const ip = req.headers['x-nf-client-connection-ip'] || req.ip, keys = ['d:' + device, 'ip:' + ip];
    if ((await db.loginBlocked(keys[0])) || (await db.loginBlocked(keys[1]))) throw httpError(429, 'Too many wrong attempts. Wait 15 minutes.');
    const secret = String(req.body.secret || '');
    let user = null;
    if (secret && (await ownerMatches(secret))) user = { role: 'owner', name: 'Owner' };
    else if (/^\d{6,8}$/.test(secret)) {
      const s = (await db.staffHashes()).find(x => checkPin(secret, x.pin_hash));
      if (s) user = { role: 'staff', id: s.id, name: s.name };
    }
    if (!user) { await db.loginFailed(keys[0], 5); await db.loginFailed(keys[1], 30); throw httpError(401, 'Wrong PIN or password'); }
    await db.loginOk(keys[0]);
    await setSession(req, res, user);
    return { role: user.role, name: user.name };
  }));
  api.post('/logout', h(async (req, res) => { await setSession(req, res, null); return { ok: true }; }));

  api.use(async (req, res, next) => {
    try { req.user = await readUser(req); } catch (e) { return next(e); }
    req.role = req.user?.role;
    req.user ? next() : res.status(401).json({ error: 'Login required' });
  });
  const ownerOnly = (req, res, next) => (req.role === 'owner' ? next() : res.status(403).json({ error: 'Only the owner can do this' }));
  const id = req => +req.params.id;
  const by = req => req.user.name;
  const publicSettings = async () => {
    const s = await db.settings();
    return Object.fromEntries(Object.entries(s).filter(([k]) => !/hash|session_ver/.test(k)));
  };

  api.get('/settings', h(publicSettings));
  api.put('/settings', ownerOnly, h(async req => { await db.saveSettings(req.body); return publicSettings(); }));

  // owner security
  api.post('/owner-password', ownerOnly, h(async (req, res) => {
    const { current, next } = req.body;
    if (!(await ownerMatches(String(current || '')))) throw httpError(400, 'Current password is wrong');
    if (String(next || '').length < 8) throw httpError(400, 'New password must be at least 8 characters');
    if (next === current) throw httpError(400, 'Choose a different password');
    await db.setSetting('owner_hash', hashPin(String(next)));
    await db.bumpSessions(); // sign out everywhere else
    await setSession(req, res, req.user);
    return { ok: true, resetFlagStillOn: RESET };
  }));
  api.post('/logout-all', ownerOnly, h(async (req, res) => { await db.bumpSessions(); await setSession(req, res, req.user); return { ok: true }; }));
  api.get('/backup', ownerOnly, async (req, res) => {
    try {
      const data = await db.backup();
      res.attachment(`hotel-backup-${data.exported_at.slice(0, 10)}.json`).json(data);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  // staff, each with their own PIN
  const validPin = pin => { if (!/^\d{6,8}$/.test(String(pin || ''))) throw httpError(400, 'PIN must be 6 to 8 digits'); };
  api.get('/staff', ownerOnly, h(() => db.staffList()));
  api.post('/staff', ownerOnly, h(async req => {
    validPin(req.body.pin);
    if (await pinTaken(req.body.pin)) throw httpError(400, 'Someone already uses that PIN. Pick another.');
    return db.addStaff(req.body.name, hashPin(String(req.body.pin)));
  }));
  api.put('/staff/:id', ownerOnly, h(async req => {
    const { pin } = req.body;
    if (pin) {
      validPin(pin);
      if (await pinTaken(pin, id(req))) throw httpError(400, 'Someone already uses that PIN. Pick another.');
    }
    const s = await db.updateStaff(id(req), req.body, pin ? hashPin(String(pin)) : null);
    if (pin) await db.bumpSessions(); // a changed PIN signs everyone out, in case the old one leaked
    return s;
  }));

  api.get('/menu', h(() => db.menu()));
  api.post('/menu', ownerOnly, h(req => db.addMenuItem(req.body)));
  api.put('/menu/:id', ownerOnly, h(req => db.updateMenuItem(id(req), req.body)));
  api.post('/menu/import', ownerOnly, h(req => db.importMenu(req.body.items)));

  api.get('/orders', h(() => db.activeOrders()));
  api.get('/orders/:id', h(async req => {
    const o = await db.order(id(req));
    // ?discount=N previews totals before billing; the real discount is validated and saved by /bill
    if (req.query.discount !== undefined && o.status !== 'billed')
      o.totals = totals(o.items, Math.min(Math.max(+req.query.discount || 0, 0), o.totals.subtotal));
    return o;
  }));
  api.post('/orders', h(req => db.createOrder({ ...req.body, by: by(req) })));
  api.post('/orders/:id/items', h(req => db.addItems(id(req), req.body.items)));
  api.post('/orders/:id/status', h(req => db.setStatus(id(req), req.body.status, req.body.reason, by(req))));
  api.post('/orders/:id/bill', h(req => db.bill(id(req), { ...req.body, by: by(req) })));
  api.post('/orders/:id/void', ownerOnly, h(req => db.voidBill(id(req), req.body.reason, by(req))));
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

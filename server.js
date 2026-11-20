// HTTP API + static UI. Run standalone (`node server.js`, web/LAN/cloud) or started inside Electron (electron.js).
const express = require('express');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { openDb, totals } = require('./db');

const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

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

async function start(dbPath, port = 4600) {
  const db = await openDb(dbPath);
  const events = new EventEmitter().setMaxListeners(0);
  const token = crypto.randomBytes(24).toString('hex'); // login cookie; a restart logs LAN devices out
  const fails = new Map();
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // The counter PC itself (localhost) never needs the PIN. Other devices on the LAN do, and LAN access stays off until a PIN is set.
  const isLocal = req => LOCAL.has(req.socket.remoteAddress);
  const authed = req => isLocal(req) || (req.headers.cookie || '').split(/;\s*/).includes('auth=' + token);

  app.post('/api/login', (req, res) => {
    const ip = req.socket.remoteAddress, f = fails.get(ip) || { n: 0, until: 0 };
    if (f.until > Date.now()) return res.status(429).json({ error: 'Too many wrong PINs. Wait 5 minutes.' });
    const pin = db.settings().pin;
    if (!pin) return res.status(403).json({ error: 'LAN access is off. Set a PIN in Settings on the counter PC.' });
    const given = Buffer.from(String(req.body.pin || '')), want = Buffer.from(pin);
    if (given.length === want.length && crypto.timingSafeEqual(given, want)) {
      fails.delete(ip);
      res.setHeader('Set-Cookie', `auth=${token}; HttpOnly; SameSite=Strict; Path=/`);
      return res.json({ ok: true });
    }
    const n = f.n + 1;
    fails.set(ip, n >= 5 ? { n: 0, until: Date.now() + 5 * 60e3 } : { n, until: 0 });
    res.status(401).json({ error: 'Wrong PIN' });
  });
  app.use('/api', (req, res, next) => (authed(req) ? next() : res.status(401).json({ error: 'Login required' })));

  const h = fn => (req, res) => {
    try { res.json(fn(req)); }
    catch (e) { if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.message }); }
  };
  const changed = (r, kot) => { events.emit('change'); if (kot) events.emit('kot', r); return r; };
  const id = req => +req.params.id;
  const publicSettings = () => { const { pin, ...s } = db.settings(); return { ...s, has_pin: !!pin }; };

  app.get('/api/info', h(req => ({
    local: isLocal(req),
    lan: Object.values(os.networkInterfaces()).flat()
      .filter(i => (i.family === 'IPv4' || i.family === 4) && !i.internal).map(i => `http://${i.address}:${port}`),
  })));
  app.get('/api/settings', h(publicSettings));
  app.put('/api/settings', h(req => {
    if (!isLocal(req)) throw Object.assign(new Error('Settings can only be changed on the counter PC'), { status: 403 });
    db.saveSettings(req.body);
    return changed(publicSettings());
  }));

  app.get('/api/menu', h(() => db.menu()));
  app.post('/api/menu', h(req => changed(db.addMenuItem(req.body))));
  app.put('/api/menu/:id', h(req => changed(db.updateMenuItem(id(req), req.body))));

  app.get('/api/orders', h(() => db.activeOrders()));
  app.get('/api/orders/:id', h(req => {
    const o = db.order(id(req));
    // ?discount=N previews totals before billing; the real discount is validated and saved by /bill
    if (req.query.discount !== undefined && o.status !== 'billed')
      o.totals = totals(o.items, Math.min(Math.max(+req.query.discount || 0, 0), o.totals.subtotal));
    return o;
  }));
  app.post('/api/orders', h(req => changed(db.createOrder(req.body), true)));
  app.post('/api/orders/:id/items', h(req => changed(db.addItems(id(req), req.body.items), true)));
  app.post('/api/orders/:id/status', h(req => changed(db.setStatus(id(req), req.body.status, req.body.reason))));
  app.post('/api/orders/:id/bill', h(req => changed(db.bill(id(req), req.body))));

  app.get('/api/folios', h(() => db.openFolios()));
  app.get('/api/folios/:id', h(req => db.folio(id(req))));
  app.post('/api/folios', h(req => changed(db.openFolio(req.body))));
  app.post('/api/folios/:id/settle', h(req => changed(db.settleFolio(id(req), req.body.mode))));

  app.get('/api/reports/:name', (req, res) => {
    const { from, to } = req.query;
    try {
      const rows = db.report(req.params.name, from, to);
      if (!req.query.csv) return res.json(rows);
      res.type('text/csv').attachment(`${req.params.name}_${from}_${to}.csv`).send(csv(rows));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // Server-Sent Events: every open screen refreshes when anything changes.
  app.get('/api/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    const send = () => res.write('data: change\n\n');
    events.on('change', send);
    req.on('close', () => events.off('change', send));
  });

  await new Promise((ok, fail) => app.listen(port, '0.0.0.0', ok).on('error', fail));
  return { db, events, port };
}

module.exports = { start };

if (require.main === module) {
  start(process.env.DB || path.join(__dirname, 'hotel.db'), +process.env.PORT || 4600)
    .then(({ port }) => console.log(`Hotel Orders running at http://localhost:${port}`))
    .catch(e => { console.error(e.message); process.exit(1); });
}

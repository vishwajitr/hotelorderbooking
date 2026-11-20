// Data layer on Postgres: Netlify DB (Neon) in the cloud, PGlite (Postgres in WASM) for local dev and tests.
// `conn` is any object with query(sql, params) -> {rows}, exec(sql) and tx(fn(client)).

const SCHEMA = `
create table if not exists menu_items(id serial primary key, category text not null default '', name text not null,
  price double precision not null, gst_pct double precision not null default 5, veg integer not null default 1, active integer not null default 1);
create table if not exists orders(id serial primary key, bill_no text unique, kind text not null, ref text not null default '',
  status text not null default 'new', note text not null default '', discount double precision not null default 0,
  subtotal double precision, tax double precision, total double precision, pay_mode text, folio_id integer,
  cancel_reason text, created_at text not null, billed_at text);
create table if not exists order_items(id serial primary key, order_id integer not null, name text not null,
  price double precision not null, gst_pct double precision not null, qty integer not null, kot_no integer not null);
create index if not exists order_items_order on order_items(order_id);
create table if not exists room_folios(id serial primary key, room_no text not null, guest text not null default '',
  opened_at text not null, settled_at text, settle_mode text);
create table if not exists settings(key text primary key, value text not null);
create table if not exists login_attempts(ip text primary key, n integer not null default 0, until double precision not null default 0);
create table if not exists staff(id serial primary key, name text not null, pin_hash text not null, active integer not null default 1);
create table if not exists categories(name text primary key);
alter table orders add column if not exists created_by text;
alter table orders add column if not exists billed_by text;
alter table orders add column if not exists cancelled_by text;
alter table orders add column if not exists void_reason text;
alter table orders add column if not exists voided_by text;
alter table orders add column if not exists voided_at text;
alter table order_items add column if not exists created_at text;
`;

const KINDS = ['table', 'room', 'takeaway'];
const ACTIVE = ['new', 'preparing', 'served'];
const NEXT = { new: 'preparing', preparing: 'served' };
const PAY = ['cash', 'upi', 'card', 'room'];
const DEFAULTS = { hotel_name: 'My Hotel', address: '', gstin: '', paper_width: '80' };
const IN_PROGRESS = `status in ('new', 'preparing', 'served')`;

const r2 = n => Math.round(n * 100) / 100;
const R2 = e => `round((${e})::numeric, 2)::float8`; // SQL rounding to paise
const pad = n => String(n).padStart(2, '0');
// Timestamps are text in hotel local time; cloud servers run in UTC, so convert explicitly.
const clock = new Intl.DateTimeFormat('sv-SE', { timeZone: process.env.HOTEL_TZ || 'Asia/Kolkata',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const stamp = (d = new Date()) => clock.format(d); // "YYYY-MM-DD HH:MM:SS"
// Indian financial year, April to March
const fy = (s = stamp()) => {
  const y = +s.slice(0, 4), start = +s.slice(5, 7) >= 4 ? y : y - 1;
  return `FY${pad(start % 100)}-${pad((start + 1) % 100)}`;
};
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const flag = (v, dflt) => (v === undefined || v === null || v === '' ? dflt : v === true || v === 1 || v === '1' || v === 'on' ? 1 : 0);

// Discount is taken off before GST; GST is split equally into CGST and SGST.
function totals(items, discount = 0) {
  const subtotal = r2(items.reduce((s, i) => s + i.price * i.qty, 0));
  const k = subtotal ? 1 - discount / subtotal : 0;
  const tax = r2(items.reduce((s, i) => s + i.price * i.qty * k * i.gst_pct / 100, 0));
  const cgst = r2(tax / 2);
  return { subtotal, discount, tax, cgst, sgst: r2(tax - cgst), total: r2(subtotal - discount + tax) };
}

function pgConn(url) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 3 });
  return {
    query: (s, p) => pool.query(s, p),
    exec: s => pool.query(s),
    async tx(fn) {
      const c = await pool.connect();
      try { await c.query('begin'); const r = await fn(c); await c.query('commit'); return r; }
      catch (e) { await c.query('rollback'); throw e; }
      finally { c.release(); }
    },
  };
}

async function openDb(conn) {
  await conn.exec(SCHEMA);
  const toPg = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + ++i); };
  const h = c => {
    const all = async (sql, p = []) => (await c.query(toPg(sql), p)).rows;
    return { all, get: async (s, p) => (await all(s, p))[0], insert: async (s, p) => (await all(s + ' returning id', p))[0].id, run: (s, p) => c.query(toPg(s), p) };
  };
  const R = h(conn); // reads outside a transaction
  const tx = fn => (...a) => conn.tx(c => fn(h(c), ...a));

  // settings
  const settings = async (q = R) => ({ ...DEFAULTS, ...Object.fromEntries((await q.all('select key, value from settings')).map(r => [r.key, r.value])) });
  const put = (q, k, v) => q.run('insert into settings(key, value) values(?, ?) on conflict(key) do update set value = excluded.value', [k, String(v)]);
  const saveSettings = tx(async (q, obj) => {
    for (const k of Object.keys(DEFAULTS)) if (obj[k] != null) await put(q, k, obj[k]);
    return settings(q);
  });
  const setSetting = tx((q, k, v) => put(q, k, v));
  // Bumping the session version signs every device out (after a PIN or password change, or on request).
  const sessionVersion = async () => +((await R.get(`select value from settings where key = 'session_ver'`))?.value || 0);
  const bumpSessions = tx(async q => {
    const v = +((await q.get(`select value from settings where key = 'session_ver'`))?.value || 0) + 1;
    await put(q, 'session_ver', v);
    return v;
  });

  // staff: each person has a name and their own PIN, so orders and bills record who did them
  const staffList = () => R.all('select id, name, active from staff order by active desc, name');
  const staffHashes = () => R.all('select id, name, pin_hash from staff where active = 1');
  const staffById = id => R.get('select id, name, active from staff where id = ?', [+id || 0]);
  const addStaff = tx(async (q, name, pinHash) => {
    name = String(name || '').trim();
    if (!name) throw bad('Enter the staff member’s name');
    return q.get('select id, name, active from staff where id = ?', [await q.insert('insert into staff(name, pin_hash) values(?, ?)', [name, pinHash])]);
  });
  const updateStaff = tx(async (q, id, { name, active }, pinHash) => {
    const s = await q.get('select * from staff where id = ?', [+id || 0]);
    if (!s) throw bad('Staff member not found', 404);
    name = name == null ? s.name : String(name).trim();
    if (!name) throw bad('Enter the staff member’s name');
    await q.run('update staff set name = ?, active = ?, pin_hash = ? where id = ?', [name, flag(active, s.active), pinHash || s.pin_hash, s.id]);
    return q.get('select id, name, active from staff where id = ?', [s.id]);
  });

  // menu
  const menu = () => R.all('select * from menu_items order by category, name');
  const menuItem = (q, id) => q.get('select * from menu_items where id = ?', [id]);
  function cleanItem(m) {
    const name = String(m.name || '').trim(), price = +m.price, gst = m.gst_pct === undefined || m.gst_pct === '' ? 5 : +m.gst_pct;
    if (!name || !(price >= 0) || !(gst >= 0 && gst <= 28)) throw bad('Item needs a name, price of 0 or more, and GST between 0 and 28%');
    return [String(m.category || '').trim(), name, price, gst, flag(m.veg, 1)];
  }
  const addMenuItem = tx(async (q, m) => menuItem(q, await q.insert('insert into menu_items(category, name, price, gst_pct, veg) values(?, ?, ?, ?, ?)', cleanItem(m))));
  const updateMenuItem = tx(async (q, id, m) => {
    if (!(await menuItem(q, id))) throw bad('Menu item not found', 404);
    await q.run('update menu_items set category = ?, name = ?, price = ?, gst_pct = ?, veg = ?, active = ? where id = ?', [...cleanItem(m), flag(m.active, 1), id]);
    return menuItem(q, id);
  });

  // categories: saved ones (may be empty) plus any a dish uses, each with its dish count
  const categoryList = () => R.all(`select c.name, count(m.id)::int dishes from
      (select name from categories union select category from menu_items where category <> '') c
      left join menu_items m on m.category = c.name group by c.name order by lower(c.name)`);
  const cleanCat = n => {
    n = String(n || '').trim();
    if (!n || n.length > 40) throw bad('Category name must be 1 to 40 characters');
    return n;
  };
  const addCategory = tx(async (q, name) => {
    name = cleanCat(name);
    if (await q.get(`select 1 from (select name from categories union select category from menu_items) c where lower(name) = lower(?)`, [name]))
      throw bad(`"${name}" already exists`);
    await q.run('insert into categories(name) values(?)', [name]);
    return { name, dishes: 0 };
  });
  const renameCategory = tx(async (q, from, to) => {
    to = cleanCat(to);
    if (from !== to && await q.get(`select 1 from (select name from categories union select category from menu_items) c where lower(name) = lower(?) and name <> ?`, [to, from]))
      throw bad(`"${to}" already exists`);
    await q.run('delete from categories where name = ?', [from]);
    await q.run('insert into categories(name) values(?) on conflict do nothing', [to]);
    await q.run('update menu_items set category = ? where category = ?', [to, from]); // dishes move with it
    return { name: to };
  });
  const deleteCategory = tx(async (q, name) => {
    const n = (await q.get('select count(*)::int n from menu_items where category = ?', [name])).n;
    if (n) throw bad(`"${name}" still has ${n} ${n === 1 ? 'dish' : 'dishes'}. Move or delete them first.`);
    await q.run('delete from categories where name = ?', [name]);
    return { ok: true };
  });

  // Bulk add from a menu file or a backup's menu_items; dishes already on the menu (same name and category) are skipped.
  const importMenu = tx(async (q, items) => {
    if (!Array.isArray(items) || !items.length) throw bad('The file has no dishes');
    if (items.length > 2000) throw bad('Too many dishes in one file');
    let added = 0, skipped = 0;
    for (const m of items) {
      const row = cleanItem(m);
      if (await q.get('select id from menu_items where lower(name) = lower(?) and lower(category) = lower(?)', [row[1], row[0]])) { skipped++; continue; }
      await q.run('insert into menu_items(category, name, price, gst_pct, veg, active) values(?, ?, ?, ?, ?, ?)', [...row, flag(m.active, 1)]);
      added++;
    }
    return { added, skipped };
  });

  // orders (items fetched in one query per list, not per order: the database is a network hop away)
  async function withItems(q, orders) {
    if (!orders.length) return orders;
    const items = await q.all('select * from order_items where order_id = any(?) order by id', [orders.map(o => o.id)]);
    for (const o of orders) { o.items = items.filter(i => i.order_id === o.id); o.totals = totals(o.items, o.discount); }
    return orders;
  }
  async function order(q, id) {
    const o = await q.get('select * from orders where id = ?', [+id || 0]);
    if (!o) throw bad('Order not found', 404);
    return (await withItems(q, [o]))[0];
  }
  const activeOrders = async () => withItems(R, await R.all(`select * from orders where ${IN_PROGRESS} order by id`));

  // Each batch of items gets the next KOT number, so the kitchen ticket shows only what's new.
  async function addLines(q, orderId, lines) {
    if (!Array.isArray(lines) || !lines.length) throw bad('Add at least one item');
    await q.run(`select pg_advisory_xact_lock(2, ${+orderId})`); // two devices adding at once get separate KOT numbers
    const kot = (await q.get('select coalesce(max(kot_no), 0) + 1 n from order_items where order_id = ?', [orderId])).n;
    for (const l of lines) {
      const qty = +l.qty;
      if (!Number.isInteger(qty) || qty < 1 || qty > 999) throw bad('Quantity must be 1 to 999');
      const m = await q.get('select * from menu_items where id = ? and active = 1', [+l.menu_id || 0]);
      if (!m) throw bad('Menu item not found');
      // name and price are copied so later menu edits never change an existing order
      await q.run('insert into order_items(order_id, name, price, gst_pct, qty, kot_no, created_at) values(?, ?, ?, ?, ?, ?, ?)', [orderId, m.name, m.price, m.gst_pct, qty, kot, stamp()]);
    }
    return { id: orderId, kot_no: kot };
  }
  const createOrder = tx(async (q, { kind, ref = '', note = '', items, by = null } = {}) => {
    if (!KINDS.includes(kind)) throw bad('Order type must be table, room or takeaway');
    ref = String(ref).trim();
    if (kind !== 'takeaway' && !ref) throw bad(`Enter the ${kind} number`);
    return addLines(q, await q.insert('insert into orders(kind, ref, note, created_at, created_by) values(?, ?, ?, ?, ?)', [kind, ref, String(note).trim(), stamp(), by]), items);
  });
  const addItems = tx(async (q, id, items) => {
    if (!ACTIVE.includes((await order(q, id)).status)) throw bad('Order is already closed');
    return addLines(q, +id, items);
  });
  const setStatus = tx(async (q, id, status, reason = '', by = null) => {
    const o = await order(q, id);
    reason = String(reason || '').trim();
    if (status === 'cancelled') {
      if (!ACTIVE.includes(o.status)) throw bad('Order is already closed');
      if (!reason) throw bad('Give a reason for cancelling');
    } else if (NEXT[o.status] !== status) throw bad(`Cannot move order from ${o.status} to ${status}`);
    const cancelled = status === 'cancelled';
    await q.run('update orders set status = ?, cancel_reason = ?, cancelled_by = ? where id = ?', [status, cancelled ? reason : null, cancelled ? by : null, o.id]);
    return order(q, o.id);
  });

  const openFolioId = async (q, room) => (await q.get('select id from room_folios where room_no = ? and settled_at is null', [room]))?.id;
  const bill = tx(async (q, id, { discount = 0, pay_mode, room_no, by = null } = {}, now = new Date()) => {
    await q.run('select pg_advisory_xact_lock(1, 0)'); // one bill at a time, so bill numbers never collide
    const o = await order(q, id);
    if (!ACTIVE.includes(o.status)) throw bad('Order is already closed');
    if (!PAY.includes(pay_mode)) throw bad('Payment must be cash, upi, card or room');
    discount = r2(+discount || 0);
    const sub = totals(o.items).subtotal;
    if (discount < 0 || discount > sub) throw bad(`Discount must be between 0 and ${sub}`);
    const t = totals(o.items, discount), at = stamp(now);
    let folio = null;
    if (pay_mode === 'room') {
      const room = String(o.kind === 'room' ? o.ref : room_no || '').trim();
      if (!room) throw bad('Enter the room number to charge');
      folio = (await openFolioId(q, room)) ?? (await q.insert('insert into room_folios(room_no, opened_at) values(?, ?)', [room, at]));
    }
    // GST invoice numbers: continuous within a financial year, e.g. FY26-27/0001
    const prefix = fy(at) + '/';
    const seq = (await q.get('select coalesce(max(cast(substr(bill_no, ?) as integer)), 0) + 1 n from orders where bill_no like ?', [prefix.length + 1, prefix + '%'])).n;
    await q.run(`update orders set status = 'billed', bill_no = ?, discount = ?, subtotal = ?, tax = ?, total = ?, pay_mode = ?, folio_id = ?, billed_at = ?, billed_by = ? where id = ?`,
      [prefix + String(seq).padStart(4, '0'), t.discount, t.subtotal, t.tax, t.total, pay_mode, folio, at, by, o.id]);
    return order(q, o.id);
  });

  // A wrong bill is voided, never deleted: its number stays used (GST invoices must be continuous) and it drops out of totals.
  const voidBill = tx(async (q, id, reason, by = null) => {
    const o = await order(q, id);
    if (o.status !== 'billed') throw bad('Only a billed order can be voided');
    reason = String(reason || '').trim();
    if (!reason) throw bad('Give a reason for voiding this bill');
    if (o.folio_id && (await q.get('select settled_at from room_folios where id = ?', [o.folio_id]))?.settled_at)
      throw bad('This bill is part of a room bill that is already settled');
    await q.run(`update orders set status = 'void', void_reason = ?, voided_by = ?, voided_at = ? where id = ?`, [reason, by, stamp(), o.id]);
    return order(q, o.id);
  });

  // Everything, for the owner's backup download.
  const backup = async () => {
    const out = { app: 'hotelorderbooking', exported_at: stamp(), tables: {} };
    for (const t of ['settings', 'menu_items', 'orders', 'order_items', 'room_folios', 'staff'])
      out.tables[t] = await R.all(`select * from ${t} order by 1`);
    out.tables.settings = out.tables.settings.filter(r => !/hash/.test(r.key));
    out.tables.staff = out.tables.staff.map(({ pin_hash, ...s }) => s); // PINs never leave the database
    return out;
  };

  // New KOTs since item id `after`, for devices that print them automatically.
  async function kots(after) {
    const last = (await R.get('select coalesce(max(id), 0)::int last from order_items')).last;
    if (after == null || after === '') return { last, kots: [] }; // first call just sets the starting point
    return { last, kots: await R.all('select order_id, kot_no, min(created_at) created_at from order_items where id > ? and id <= ? group by order_id, kot_no order by min(id)', [+after || 0, last]) };
  }

  // room folios (charge to room, settle at checkout)
  async function folio(q, id) {
    const f = await q.get('select * from room_folios where id = ?', [+id || 0]);
    if (!f) throw bad('Room bill not found', 404);
    f.orders = await withItems(q, await q.all(`select * from orders where folio_id = ? and status = 'billed' order by id`, [f.id]));
    f.total = r2(f.orders.reduce((s, o) => s + o.total, 0));
    return f;
  }
  const openFolios = async () => Promise.all((await R.all('select id from room_folios where settled_at is null order by room_no')).map(r => folio(R, r.id)));
  const openFolio = tx(async (q, { room_no, guest = '' } = {}) => {
    room_no = String(room_no || '').trim();
    if (!room_no) throw bad('Enter the room number');
    if (await openFolioId(q, room_no)) throw bad(`Room ${room_no} already has an open bill`);
    return folio(q, await q.insert('insert into room_folios(room_no, guest, opened_at) values(?, ?, ?)', [room_no, String(guest).trim(), stamp()]));
  });
  const settleFolio = tx(async (q, id, mode) => {
    const f = await folio(q, id);
    if (f.settled_at) throw bad('Room bill already settled');
    if (!['cash', 'upi', 'card'].includes(mode)) throw bad('Settle by cash, upi or card');
    if (await q.get(`select id from orders where kind = 'room' and ref = ? and ${IN_PROGRESS}`, [f.room_no]))
      throw bad(`Room ${f.room_no} has unbilled orders. Bill them first.`);
    await q.run('update room_folios set settled_at = ?, settle_mode = ? where id = ?', [stamp(), mode, f.id]);
    return folio(q, f.id);
  });

  // reports, dates as YYYY-MM-DD inclusive
  function report(name, from, to) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw bad('from and to must be YYYY-MM-DD');
    const range = [from, to];
    if (name === 'dayend') return Promise.all([
      R.all(`select 'Bills: ' || pay_mode head, count(*)::int bills, ${R2('sum(subtotal)')} subtotal, ${R2('sum(discount)')} discount,
        ${R2('sum(tax)')} gst, ${R2('sum(total)')} total from orders where status = 'billed' and left(billed_at, 10) between ? and ? group by pay_mode order by 1`, range),
      R.all(`select 'Room checkout: ' || f.settle_mode head, count(distinct f.id)::int bills, null::float8 subtotal, null::float8 discount, null::float8 gst,
        ${R2('sum(o.total)')} total from room_folios f join orders o on o.folio_id = f.id where left(f.settled_at, 10) between ? and ? group by f.settle_mode order by 1`, range),
    ]).then(([a, b]) => [...a, ...b]);
    if (name === 'summary') { // one object for the day-end screen: tiles, sales by order type, GST
      const billed = `from orders where status = 'billed' and left(billed_at, 10) between ? and ?`;
      return Promise.all([
        R.get(`select count(*)::int bills, ${R2('coalesce(sum(total), 0)')} gross, ${R2('coalesce(sum(subtotal - discount), 0)')} net,
          ${R2('coalesce(sum(tax), 0)')} tax, ${R2('coalesce(sum(discount), 0)')} discount ${billed}`, range),
        R.all(`select kind, count(*)::int bills, ${R2('sum(total)')} total ${billed} group by kind order by total desc`, range),
        R.all(`select pay_mode, count(*)::int bills, ${R2('sum(total)')} total ${billed} group by pay_mode order by total desc`, range),
      ]).then(([t, byType, byPay]) => ({ ...t, avg: t.bills ? r2(t.gross / t.bills) : 0, cgst: r2(t.tax / 2), sgst: r2(t.tax - r2(t.tax / 2)), byType, byPay }));
    }
    if (name === 'items') return R.all(`select i.name item, sum(i.qty)::int qty, ${R2('sum(i.price * i.qty)')} amount from order_items i
      join orders o on o.id = i.order_id where o.status = 'billed' and left(o.billed_at, 10) between ? and ? group by i.name order by amount desc`, range);
    if (name === 'bills') return R.all(`select id, bill_no, billed_at, case kind when 'takeaway' then 'Takeaway' else initcap(kind) || ' ' || ref end "for",
      pay_mode payment, total, status, coalesce(billed_by, '') billed_by, coalesce(void_reason, '') void_reason
      from orders where status in ('billed', 'void') and left(billed_at, 10) between ? and ? order by billed_at, id`, range);
    if (name === 'cancelled') return R.all(`select o.id, o.kind, o.ref, o.created_at, o.cancel_reason reason, coalesce(o.cancelled_by, '') cancelled_by, ${R2('coalesce(sum(i.price * i.qty), 0)')} value
      from orders o left join order_items i on i.order_id = o.id where o.status = 'cancelled' and left(o.created_at, 10) between ? and ? group by o.id order by o.id`, range);
    throw bad('Unknown report', 404);
  }

  // failed-login lockout per IP (kept in the database because serverless functions don't share memory)
  const loginBlocked = async ip => ((await R.get('select until from login_attempts where ip = ?', [ip]))?.until || 0) > Date.now();
  // key is a device or an address; max = wrong tries before a 15-minute lock
  const loginFailed = tx(async (q, ip, max = 5) => {
    const n = ((await q.get('select n from login_attempts where ip = ?', [ip]))?.n || 0) + 1;
    await q.run('insert into login_attempts(ip, n, until) values(?, ?, ?) on conflict(ip) do update set n = excluded.n, until = excluded.until',
      n >= max ? [ip, 0, Date.now() + 15 * 60e3] : [ip, n, 0]);
  });
  const loginOk = ip => R.run('delete from login_attempts where ip = ?', [ip]);

  return {
    settings, saveSettings, setSetting, sessionVersion, bumpSessions, staffList, staffHashes, staffById, addStaff, updateStaff,
    voidBill, backup, menu, addMenuItem, updateMenuItem, importMenu, categoryList, addCategory, renameCategory, deleteCategory,
    order: id => order(R, id), activeOrders, createOrder, addItems, setStatus, bill, kots,
    folio: id => folio(R, id), openFolios, openFolio, settleFolio, report,
    loginBlocked, loginFailed, loginOk,
  };
}

module.exports = { openDb, pgConn, totals, fy, stamp };

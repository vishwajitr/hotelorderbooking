// Data layer. sql.js = SQLite compiled to WASM: same code runs in Node, Electron, Windows and Mac with no native rebuild.
const fs = require('fs');
const initSqlJs = require('sql.js');

const SCHEMA = `
create table if not exists menu_items(id integer primary key, category text not null default '', name text not null,
  price real not null, gst_pct real not null default 5, veg integer not null default 1, active integer not null default 1);
create table if not exists orders(id integer primary key, bill_no text unique, kind text not null, ref text not null default '',
  status text not null default 'new', note text not null default '', discount real not null default 0,
  subtotal real, tax real, total real, pay_mode text, folio_id integer, cancel_reason text, created_at text not null, billed_at text);
create table if not exists order_items(id integer primary key, order_id integer not null, name text not null,
  price real not null, gst_pct real not null, qty integer not null, kot_no integer not null);
create table if not exists room_folios(id integer primary key, room_no text not null, guest text not null default '',
  opened_at text not null, settled_at text, settle_mode text);
create table if not exists settings(key text primary key, value text not null);
`;

const KINDS = ['table', 'room', 'takeaway'];
const ACTIVE = ['new', 'preparing', 'served'];
const NEXT = { new: 'preparing', preparing: 'served' };
const PAY = ['cash', 'upi', 'card', 'room'];
const DEFAULTS = { hotel_name: 'My Hotel', address: '', gstin: '', paper_width: '80', printer: '', auto_kot: '1', pin: '' };

const r2 = n => Math.round(n * 100) / 100;
const pad = n => String(n).padStart(2, '0');
const stamp = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
// Indian financial year, April to March
const fy = (d = new Date()) => {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `FY${pad(y % 100)}-${pad((y + 1) % 100)}`;
};
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// Discount is taken off before GST; GST is split equally into CGST and SGST.
function totals(items, discount = 0) {
  const subtotal = r2(items.reduce((s, i) => s + i.price * i.qty, 0));
  const k = subtotal ? 1 - discount / subtotal : 0;
  const tax = r2(items.reduce((s, i) => s + i.price * i.qty * k * i.gst_pct / 100, 0));
  const cgst = r2(tax / 2);
  return { subtotal, discount, tax, cgst, sgst: r2(tax - cgst), total: r2(subtotal - discount + tax) };
}

async function openDb(file) {
  const SQL = await initSqlJs();
  const db = new SQL.Database(file && fs.existsSync(file) ? fs.readFileSync(file) : undefined);
  db.exec(SCHEMA);

  // ponytail: whole DB file rewritten after every write; fine up to tens of MB. Move to Postgres for the cloud version.
  const save = () => {
    if (!file) return;
    fs.writeFileSync(file + '.tmp', db.export());
    fs.renameSync(file + '.tmp', file); // atomic swap: a crash mid-write never corrupts hotel.db
  };
  const all = (sql, p = []) => {
    const s = db.prepare(sql);
    s.bind(p);
    const out = [];
    while (s.step()) out.push(s.getAsObject());
    s.free();
    return out;
  };
  const get = (sql, p) => all(sql, p)[0];
  const insert = (sql, p) => { db.run(sql, p); return get('select last_insert_rowid() id').id; };
  const tx = fn => (...a) => {
    db.exec('begin');
    try { const r = fn(...a); db.exec('commit'); save(); return r; }
    catch (e) { db.exec('rollback'); throw e; }
  };
  const flag = (v, dflt) => (v === undefined || v === null || v === '' ? dflt : v === true || v === 1 || v === '1' || v === 'on' ? 1 : 0);

  // settings
  const settings = () => ({ ...DEFAULTS, ...Object.fromEntries(all('select key, value from settings').map(r => [r.key, r.value])) });
  const saveSettings = tx(obj => {
    if (obj.pin && !/^\d{4,8}$/.test(obj.pin)) throw bad('PIN must be 4 to 8 digits');
    for (const k of Object.keys(DEFAULTS)) if (obj[k] != null)
      db.run('insert into settings(key, value) values(?, ?) on conflict(key) do update set value = excluded.value', [k, String(obj[k])]);
    return settings();
  });

  // menu
  const menu = () => all('select * from menu_items order by category, name');
  const menuItem = id => get('select * from menu_items where id = ?', [id]);
  function cleanItem(m) {
    const name = String(m.name || '').trim(), price = +m.price, gst = m.gst_pct === undefined || m.gst_pct === '' ? 5 : +m.gst_pct;
    if (!name || !(price >= 0) || !(gst >= 0 && gst <= 28)) throw bad('Item needs a name, price of 0 or more, and GST between 0 and 28%');
    return [String(m.category || '').trim(), name, price, gst, flag(m.veg, 1)];
  }
  const addMenuItem = tx(m => menuItem(insert('insert into menu_items(category, name, price, gst_pct, veg) values(?, ?, ?, ?, ?)', cleanItem(m))));
  const updateMenuItem = tx((id, m) => {
    if (!menuItem(id)) throw bad('Menu item not found', 404);
    db.run('update menu_items set category = ?, name = ?, price = ?, gst_pct = ?, veg = ?, active = ? where id = ?', [...cleanItem(m), flag(m.active, 1), id]);
    return menuItem(id);
  });

  // orders
  function order(id) {
    const o = get('select * from orders where id = ?', [id]);
    if (!o) throw bad('Order not found', 404);
    o.items = all('select * from order_items where order_id = ? order by id', [id]);
    o.totals = totals(o.items, o.discount);
    return o;
  }
  const activeOrders = () => all(`select id from orders where status in ('new', 'preparing', 'served') order by id`).map(r => order(r.id));

  // Each batch of items gets the next KOT number, so the kitchen ticket shows only what's new.
  function addLines(orderId, lines) {
    if (!Array.isArray(lines) || !lines.length) throw bad('Add at least one item');
    const kot = get('select coalesce(max(kot_no), 0) + 1 n from order_items where order_id = ?', [orderId]).n;
    for (const l of lines) {
      const qty = +l.qty;
      if (!Number.isInteger(qty) || qty < 1 || qty > 999) throw bad('Quantity must be 1 to 999');
      const m = get('select * from menu_items where id = ? and active = 1', [+l.menu_id || 0]);
      if (!m) throw bad('Menu item not found');
      // name and price are copied so later menu edits never change an existing order
      db.run('insert into order_items(order_id, name, price, gst_pct, qty, kot_no) values(?, ?, ?, ?, ?, ?)', [orderId, m.name, m.price, m.gst_pct, qty, kot]);
    }
    return { id: orderId, kot_no: kot };
  }
  const createOrder = tx(({ kind, ref = '', note = '', items } = {}) => {
    if (!KINDS.includes(kind)) throw bad('Order type must be table, room or takeaway');
    ref = String(ref).trim();
    if (kind !== 'takeaway' && !ref) throw bad(`Enter the ${kind} number`);
    return addLines(insert('insert into orders(kind, ref, note, created_at) values(?, ?, ?, ?)', [kind, ref, String(note).trim(), stamp()]), items);
  });
  const addItems = tx((id, items) => {
    if (!ACTIVE.includes(order(id).status)) throw bad('Order is already closed');
    return addLines(id, items);
  });
  const setStatus = tx((id, status, reason = '') => {
    const o = order(id);
    reason = String(reason || '').trim();
    if (status === 'cancelled') {
      if (!ACTIVE.includes(o.status)) throw bad('Order is already closed');
      if (!reason) throw bad('Give a reason for cancelling');
    } else if (NEXT[o.status] !== status) throw bad(`Cannot move order from ${o.status} to ${status}`);
    db.run('update orders set status = ?, cancel_reason = ? where id = ?', [status, status === 'cancelled' ? reason : null, id]);
    return order(id);
  });

  const openFolioId = room => get('select id from room_folios where room_no = ? and settled_at is null', [room])?.id;
  const bill = tx((id, { discount = 0, pay_mode, room_no } = {}, now = new Date()) => {
    const o = order(id);
    if (!ACTIVE.includes(o.status)) throw bad('Order is already closed');
    if (!PAY.includes(pay_mode)) throw bad('Payment must be cash, upi, card or room');
    discount = r2(+discount || 0);
    const sub = totals(o.items).subtotal;
    if (discount < 0 || discount > sub) throw bad(`Discount must be between 0 and ${sub}`);
    const t = totals(o.items, discount);
    let folio = null;
    if (pay_mode === 'room') {
      const room = String(o.kind === 'room' ? o.ref : room_no || '').trim();
      if (!room) throw bad('Enter the room number to charge');
      folio = openFolioId(room) ?? insert('insert into room_folios(room_no, opened_at) values(?, ?)', [room, stamp(now)]);
    }
    // GST invoice numbers: continuous within a financial year, e.g. FY26-27/0001
    const prefix = fy(now) + '/';
    const seq = get('select coalesce(max(cast(substr(bill_no, ?) as integer)), 0) + 1 n from orders where bill_no like ?', [prefix.length + 1, prefix + '%']).n;
    db.run(`update orders set status = 'billed', bill_no = ?, discount = ?, subtotal = ?, tax = ?, total = ?, pay_mode = ?, folio_id = ?, billed_at = ? where id = ?`,
      [prefix + String(seq).padStart(4, '0'), t.discount, t.subtotal, t.tax, t.total, pay_mode, folio, stamp(now), id]);
    return order(id);
  });

  // room folios (charge to room, settle at checkout)
  function folio(id) {
    const f = get('select * from room_folios where id = ?', [id]);
    if (!f) throw bad('Room bill not found', 404);
    f.orders = all('select id from orders where folio_id = ? order by id', [id]).map(r => order(r.id));
    f.total = r2(f.orders.reduce((s, o) => s + o.total, 0));
    return f;
  }
  const openFolios = () => all('select id from room_folios where settled_at is null order by room_no').map(r => folio(r.id));
  const openFolio = tx(({ room_no, guest = '' } = {}) => {
    room_no = String(room_no || '').trim();
    if (!room_no) throw bad('Enter the room number');
    if (openFolioId(room_no)) throw bad(`Room ${room_no} already has an open bill`);
    return folio(insert('insert into room_folios(room_no, guest, opened_at) values(?, ?, ?)', [room_no, String(guest).trim(), stamp()]));
  });
  const settleFolio = tx((id, mode) => {
    const f = folio(id);
    if (f.settled_at) throw bad('Room bill already settled');
    if (!['cash', 'upi', 'card'].includes(mode)) throw bad('Settle by cash, upi or card');
    if (get(`select id from orders where kind = 'room' and ref = ? and status in ('new', 'preparing', 'served')`, [f.room_no]))
      throw bad(`Room ${f.room_no} has unbilled orders. Bill them first.`);
    db.run('update room_folios set settled_at = ?, settle_mode = ? where id = ?', [stamp(), mode, id]);
    return folio(id);
  });

  // reports, dates as YYYY-MM-DD inclusive
  function report(name, from, to) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw bad('from and to must be YYYY-MM-DD');
    const range = [from, to];
    if (name === 'dayend') return [
      ...all(`select 'Bills: ' || pay_mode head, count(*) bills, round(sum(subtotal), 2) subtotal, round(sum(discount), 2) discount,
        round(sum(tax), 2) gst, round(sum(total), 2) total from orders where status = 'billed' and date(billed_at) between ? and ? group by pay_mode`, range),
      ...all(`select 'Room checkout: ' || f.settle_mode head, count(distinct f.id) bills, null subtotal, null discount, null gst, round(sum(o.total), 2) total
        from room_folios f join orders o on o.folio_id = f.id where date(f.settled_at) between ? and ? group by f.settle_mode`, range),
    ];
    if (name === 'items') return all(`select i.name item, sum(i.qty) qty, round(sum(i.price * i.qty), 2) amount from order_items i
      join orders o on o.id = i.order_id where o.status = 'billed' and date(o.billed_at) between ? and ? group by i.name order by amount desc`, range);
    if (name === 'cancelled') return all(`select o.id, o.kind, o.ref, o.created_at, o.cancel_reason reason, round(sum(i.price * i.qty), 2) value
      from orders o left join order_items i on i.order_id = o.id where o.status = 'cancelled' and date(o.created_at) between ? and ? group by o.id order by o.id`, range);
    throw bad('Unknown report', 404);
  }

  return { settings, saveSettings, menu, addMenuItem, updateMenuItem, order, activeOrders, createOrder, addItems, setStatus, bill,
    folio, openFolios, openFolio, settleFolio, report };
}

module.exports = { openDb, totals, fy };

// Self-check: `node db.js`
if (require.main === module) (async () => {
  const assert = require('assert');
  assert.strictEqual(fy(new Date(2027, 2, 31)), 'FY26-27');
  assert.strictEqual(fy(new Date(2027, 3, 1)), 'FY27-28');

  const db = await openDb(null);
  const tea = db.addMenuItem({ name: 'Tea', price: 20, gst_pct: 5 });
  const dosa = db.addMenuItem({ name: 'Dosa', price: 100, gst_pct: 5, category: 'South Indian' });
  assert.throws(() => db.createOrder({ kind: 'table', items: [{ menu_id: tea.id, qty: 1 }] }), /table number/);

  let r = db.createOrder({ kind: 'table', ref: '4', items: [{ menu_id: tea.id, qty: 2 }] });
  assert.strictEqual(r.kot_no, 1);
  r = db.addItems(r.id, [{ menu_id: dosa.id, qty: 1 }]);
  assert.strictEqual(r.kot_no, 2);
  db.updateMenuItem(dosa.id, { name: 'Dosa', price: 999, gst_pct: 5 }); // must not change the existing order
  assert.throws(() => db.setStatus(r.id, 'served'), /Cannot move/);
  db.setStatus(r.id, 'preparing');
  assert.throws(() => db.bill(r.id, { discount: 500, pay_mode: 'cash' }), /Discount/);
  // subtotal 140, discount 14, taxable 126, GST 5% = 6.30, total 132.30
  let o = db.bill(r.id, { discount: 14, pay_mode: 'upi' }, new Date(2027, 2, 31));
  assert.deepStrictEqual([o.subtotal, o.tax, o.total, o.bill_no], [140, 6.3, 132.3, 'FY26-27/0001']);
  assert.deepStrictEqual([o.totals.cgst, o.totals.sgst], [3.15, 3.15]);
  assert.throws(() => db.bill(r.id, { pay_mode: 'cash' }), /closed/);

  // room service, charged to the room, new financial year restarts numbering
  r = db.createOrder({ kind: 'room', ref: '101', items: [{ menu_id: tea.id, qty: 1 }] });
  o = db.bill(r.id, { pay_mode: 'room' }, new Date(2027, 3, 1));
  assert.strictEqual(o.bill_no, 'FY27-28/0001');
  const r2b = db.createOrder({ kind: 'room', ref: '101', items: [{ menu_id: dosa.id, qty: 1 }] });
  assert.throws(() => db.settleFolio(o.folio_id, 'cash'), /unbilled/);
  db.bill(r2b.id, { pay_mode: 'room' }, new Date(2027, 3, 1));
  const f = db.folio(o.folio_id);
  assert.strictEqual(f.orders.length, 2);
  assert.strictEqual(f.total, 1069.95); // 21 + 1048.95
  db.settleFolio(f.id, 'cash');
  assert.strictEqual(db.openFolios().length, 0);

  const c = db.createOrder({ kind: 'takeaway', items: [{ menu_id: tea.id, qty: 1 }] });
  assert.throws(() => db.setStatus(c.id, 'cancelled', ''), /reason/);
  db.setStatus(c.id, 'cancelled', 'customer left');
  assert.strictEqual(db.activeOrders().length, 0);
  assert.strictEqual(db.report('items', '2027-04-01', '2027-04-01').length, 2);
  assert.strictEqual(db.report('dayend', '2027-03-31', '2027-03-31')[0].total, 132.3);
  console.log('db self-check ok');
})().catch(e => { console.error(e); process.exit(1); });

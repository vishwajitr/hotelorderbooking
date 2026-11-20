// UI: plain DOM, talks only to /api. Same file runs on Netlify, locally, and inside the desktop app.
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = n => '₹' + (+n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inr0 = n => '₹' + Math.round(+n || 0).toLocaleString('en-IN');
const label = o => (o.kind === 'takeaway' ? (o.ref ? `Takeaway · ${o.ref}` : 'Takeaway') : `${o.kind === 'room' ? 'Room' : 'Table'} ${o.ref}`);
const mark = veg => `<span class="mark ${veg ? 'veg' : 'nonveg'}" role="img" aria-label="${veg ? 'Veg' : 'Non-veg'}"></span>`;
const press = (group, attr, value) => $$(`${group} [${attr}]`).forEach(b => b.setAttribute('aria-pressed', String(b.getAttribute(attr) === String(value))));
const PAY = [['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card']];
const KINDS = { table: ['Table no.', 'e.g. T4'], room: ['Room no.', 'e.g. 101'], takeaway: ['Customer name', 'Optional'] };

let menu = [], orders = [], folios = [], settings = {}, role = null;
let addingTo = null, kind = 'table', cat = 'All', liveFilter = 'all', newVeg = 1;
const cart = new Map(); // menu_id -> qty

async function api(url, body, method = body ? 'POST' : 'GET') {
  const r = await fetch('/api' + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== '/login') { if (!$('#login').open) $('#login').showModal(); throw new Error('Login required'); }
  if (!r.ok) { if (url !== '/login') alert(data.error || 'Request failed'); throw new Error(data.error || 'Request failed'); }
  if (method !== 'GET' && !url.startsWith('/log')) setTimeout(() => refresh().catch(() => {})); // show the change at once
  return data;
}

// Desktop prints silently to the chosen thermal printer; a browser prints from a hidden frame (print dialog shows,
// unless Chrome runs with --kiosk-printing). A hidden frame, unlike a pop-up, isn't blocked when printing KOTs automatically.
async function print(type, id, kot = '') {
  if (window.desktop) {
    const r = await window.desktop.print(type, id, kot, localStorage.printer || '');
    if (r !== 'ok') alert('Print failed: ' + r);
  } else {
    const f = Object.assign(document.createElement('iframe'), { src: `/ticket.html?type=${type}&id=${id}&kot=${kot}&auto=1`, title: 'Print' });
    f.style.cssText = 'position:fixed;width:0;height:0;border:0;';
    document.body.append(f);
    setTimeout(() => f.remove(), 60000);
  }
}

// Small modal form (window.prompt does not work in Electron). Resolves to the form values, or null if closed.
function ask(title, fields, okText = 'OK') {
  const d = $('#dlg');
  d.innerHTML = `<form method="dialog"><h3>${title}</h3>${fields}
    <menu><button class="btn" value="" formnovalidate>Close</button><button class="btn primary" value="ok">${okText}</button></menu></form>`;
  d.returnValue = '';
  d.showModal();
  return new Promise(res => (d.onclose = () => res(d.returnValue === 'ok' ? Object.fromEntries(new FormData(d.querySelector('form'))) : null)));
}

// ---------- tabs ----------
function show(tab) {
  if (!document.getElementById(tab)) tab = 'new';
  $$('main > section').forEach(s => (s.hidden = s.id !== tab));
  $$('.tabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  history.replaceState(null, '', '#' + tab);
  if (tab === 'reports' && role) runReport().catch(() => {});
}
$$('.tabs [data-tab]').forEach(b => (b.onclick = () => show(b.dataset.tab)));

// ---------- new order ----------
const active = () => menu.filter(m => m.active);
const categories = () => [...new Set(menu.map(m => m.category).filter(Boolean))].sort();
function renderCats() {
  const list = ['All', ...new Set(active().map(m => m.category || 'Other'))];
  if (!list.includes(cat)) cat = 'All';
  $('#catList').innerHTML = list.map(c => {
    const n = c === 'All' ? active().length : active().filter(m => (m.category || 'Other') === c).length;
    return `<button type="button" class="cat ${c === cat ? 'on' : ''}" data-cat="${esc(c)}"><span>${c === 'All' ? 'All items' : esc(c)}</span><span>${n}</span></button>`;
  }).join('');
}
function renderMenu() {
  const q = $('#search').value.trim().toLowerCase();
  const shown = active().filter(m => (cat === 'All' || (m.category || 'Other') === cat) && (!q || m.name.toLowerCase().includes(q)));
  $('#menuHeading').textContent = cat === 'All' ? 'All items' : cat;
  $('#menuCount').textContent = `${shown.length} ${shown.length === 1 ? 'dish' : 'dishes'}`;
  $('#menuGrid').innerHTML = shown.map(m => {
    const qty = cart.get(m.id) || 0;
    return `<button type="button" class="tile ${qty ? 'in' : ''}" data-add="${m.id}" aria-label="Add ${esc(m.name)}, ₹${m.price}">
      <span class="tile-top">${mark(m.veg)}${qty ? `<span class="qty-badge">× ${qty}</span>` : ''}</span>
      <span class="tile-name">${esc(m.name)}</span><span class="tile-price">₹${m.price}</span></button>`;
  }).join('') || `<div class="empty" style="grid-column: 1 / -1">${menu.length ? 'No dishes match that search.' : 'No menu yet. The owner adds dishes in Settings.'}</div>`;
}
function renderCart() {
  let sub = 0, tax = 0, n = 0;
  const lines = [...cart].map(([id, qty]) => {
    const m = menu.find(x => x.id === id);
    if (!m) return '';
    sub += m.price * qty; tax += m.price * qty * m.gst_pct / 100; n += qty;
    return `<div class="line">${mark(m.veg)}<div class="line-name"><b>${esc(m.name)}</b><span>₹${m.price} each</span></div>
      <div class="stepper"><button type="button" data-q="${id}" data-d="-1" aria-label="Remove one ${esc(m.name)}">−</button><b>${qty}</b><button type="button" data-q="${id}" data-d="1" aria-label="Add one ${esc(m.name)}">+</button></div>
      <div class="line-total">${inr(m.price * qty)}</div></div>`;
  }).join('');
  $('#cart').innerHTML = lines || '<div class="empty" style="border: 0; background: none">Tap a dish to add it to this order.</div>';
  const t = Math.round(tax * 100) / 100, cgst = Math.round(t * 50) / 100;
  $('#sumSub').textContent = inr(sub);
  $('#sumCgst').textContent = inr(cgst);
  $('#sumSgst').textContent = inr(t - cgst);
  $('#sumTotal').textContent = inr(sub + t);
  $('#cartCount').textContent = `${n} ${n === 1 ? 'item' : 'items'}`;
}
function renderKind() {
  press('#kindSeg', 'data-kind', kind);
  $('#refLabel').textContent = KINDS[kind][0];
  $('#ref').placeholder = KINDS[kind][1];
}
function renderAdding() {
  $('#adding').hidden = !addingTo;
  $('#orderHead').hidden = !!addingTo;
  $('#noteField').hidden = !!addingTo;
  if (addingTo) $('#addingLabel').textContent = `${label(addingTo)} (order #${addingTo.id})`;
  $('#cartTitle').textContent = addingTo ? 'Add items' : 'Current order';
  $('#saveOrder').textContent = addingTo ? 'Add & send KOT' : 'Save & send KOT';
}
$('#catList').onclick = e => { const b = e.target.closest('[data-cat]'); if (b) { cat = b.dataset.cat; renderCats(); renderMenu(); } };
$('#search').oninput = renderMenu;
$('#kindSeg').onclick = e => { const b = e.target.closest('[data-kind]'); if (b) { kind = b.dataset.kind; renderKind(); } };
$('#menuGrid').onclick = e => {
  const b = e.target.closest('[data-add]');
  if (!b) return;
  const id = +b.dataset.add;
  cart.set(id, (cart.get(id) || 0) + 1);
  $('#sent').hidden = true;
  renderCart(); renderMenu();
};
$('#cart').onclick = e => {
  const b = e.target.closest('[data-q]');
  if (!b) return;
  const id = +b.dataset.q, q = cart.get(id) + +b.dataset.d;
  q > 0 ? cart.set(id, q) : cart.delete(id);
  renderCart(); renderMenu();
};
$('#cancelAdd').onclick = () => { addingTo = null; renderAdding(); };
$('#clearOrder').onclick = () => { cart.clear(); $('#note').value = ''; renderCart(); renderMenu(); };
$('#saveOrder').onclick = async () => {
  if (!cart.size) return alert('Add at least one dish');
  const items = [...cart].map(([menu_id, qty]) => ({ menu_id, qty }));
  await (addingTo
    ? api(`/orders/${addingTo.id}/items`, { items })
    : api('/orders', { kind, ref: $('#ref').value, note: $('#note').value, items }));
  cart.clear();
  addingTo = null;
  $('#ref').value = $('#note').value = '';
  $('#sent').hidden = false;
  renderCart(); renderMenu(); renderAdding();
};

// ---------- live kitchen ----------
const COLS = [
  { id: 'new', name: 'New', dot: '#C2410C', action: 'Start preparing', next: 'preparing' },
  { id: 'preparing', name: 'Preparing', dot: '#E8922A', action: 'Mark served', next: 'served' },
  { id: 'served', name: 'Served', dot: '#1E7B45' },
];
function ticket(o, col) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(o.created_at.replace(' ', 'T') + '+05:30')) / 60000));
  const late = col.id !== 'served' && mins >= 12;
  const qty = {};
  for (const i of o.items) qty[i.name] = (qty[i.name] || 0) + i.qty; // merge repeats from later KOTs
  return `<article class="ticket">
    <div class="ticket-top"><span class="display">#${o.id}</span><span class="chip">${esc(label(o))}</span>
      <span class="age ${late ? 'late' : ''}">${mins} min</span></div>
    ${late ? '<div class="late-flag">Running late</div>' : ''}
    <ul>${Object.entries(qty).map(([n, q]) => `<li><b>${q}×</b><span>${esc(n)}</span></li>`).join('')}</ul>
    ${o.note ? `<div class="ticket-note">Note: ${esc(o.note)}</div>` : ''}
    ${col.next ? `<button type="button" class="btn advance ${col.id}" data-act="next" data-id="${o.id}">${col.action}</button>` : ''}
    <div class="ticket-actions">
      <button type="button" class="btn" data-act="add" data-id="${o.id}">+ Items</button>
      <button type="button" class="btn" data-act="kot" data-id="${o.id}">KOT</button>
      <button type="button" class="btn" data-act="cancel" data-id="${o.id}">Cancel</button>
      <button type="button" class="btn dark bill" data-act="bill" data-id="${o.id}">Bill ${inr(o.totals.total)}</button>
    </div></article>`;
}
function renderBoard() {
  press('#liveFilter', 'data-f', liveFilter);
  const shown = orders.filter(o => liveFilter === 'all' || o.kind === liveFilter);
  $('#board').innerHTML = COLS.map(c => {
    const list = shown.filter(o => o.status === c.id);
    return `<section class="col" aria-label="${c.name}"><div class="col-head"><span class="dot" style="background:${c.dot}" aria-hidden="true"></span>
      <h2>${c.name}</h2><span class="n">${list.length}</span></div>
      ${list.map(o => ticket(o, c)).join('') || '<div class="empty" style="background: transparent">Nothing here</div>'}</section>`;
  }).join('');
  $('#liveCount').textContent = orders.length || '';
}
$('#liveFilter').onclick = e => { const b = e.target.closest('[data-f]'); if (b) { liveFilter = b.dataset.f; renderBoard(); } };
$('#board').onclick = async e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const o = orders.find(x => x.id === +b.dataset.id);
  if (!o) return;
  const act = b.dataset.act;
  if (act === 'next') await api(`/orders/${o.id}/status`, { status: COLS.find(c => c.id === o.status).next });
  if (act === 'kot') print('kot', o.id);
  if (act === 'add') { addingTo = o; cart.clear(); renderAdding(); renderCart(); renderMenu(); show('new'); }
  if (act === 'cancel') {
    const f = await ask(`Cancel ${esc(label(o))}?`, '<label class="field">Reason<input name="reason" required></label>', 'Cancel order');
    if (f) await api(`/orders/${o.id}/status`, { status: 'cancelled', reason: f.reason });
  }
  if (act === 'bill') billDialog(o);
};

async function billDialog(o) {
  const t = o.totals, src = d => `/ticket.html?type=bill&id=${o.id}&discount=${encodeURIComponent(d || 0)}`;
  const answer = ask(`Bill · ${esc(label(o))}`, `<div class="bill-dialog">
    <iframe class="bill-preview" src="${src(0)}" title="Bill preview"></iframe>
    <div>
      <label class="field">Discount (₹)<input name="discount" type="number" min="0" max="${t.subtotal}" step="0.01" value="0"></label>
      <div class="field">Payment<div class="pay-grid">
        ${[...PAY, ['room', 'Charge to room']].map(([v, l], i) => `<label><input type="radio" name="pay_mode" value="${v}" ${i ? '' : 'checked'}>${l}</label>`).join('')}
      </div></div>
      ${o.kind === 'room' ? '' : '<label class="field">Room no. (only if charging to a room)<input name="room_no"></label>'}
      <p class="muted small">The preview updates as you change the discount. Nothing is billed until you press Bill &amp; print.</p>
    </div></div>`, 'Bill & print');
  let timer;
  $('#dlg [name=discount]').oninput = e => {
    clearTimeout(timer);
    timer = setTimeout(() => ($('#dlg .bill-preview').src = src(e.target.value)), 300);
  };
  const f = await answer;
  if (!f) return;
  const billed = await api(`/orders/${o.id}/bill`, f);
  print('bill', billed.id);
}

// ---------- rooms ----------
const when = s => new Date(s.replace(' ', 'T')).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
function renderFolios() {
  const due = folios.reduce((s, f) => s + f.total, 0);
  $('#roomStats').innerHTML = `<span><b>${folios.length}</b> ${folios.length === 1 ? 'room' : 'rooms'} open</span><span><b>${inr(due)}</b> to collect at checkout</span>`;
  $('#folios').innerHTML = folios.map(f => `<article class="card room">
    <div class="room-top"><div><div class="eyebrow" style="padding: 0">Room</div><div class="room-no">${esc(f.room_no)}</div></div>
      <div class="room-meta"><span>Since ${esc(when(f.opened_at))}</span>${f.guest ? `<b style="color: var(--ink)">${esc(f.guest)}</b>` : '<span>No guest name</span>'}</div></div>
    ${f.orders.length ? `<ul>${f.orders.map(o => `<li><span>Bill ${esc(o.bill_no)}</span><span>${inr(o.total)}</span></li>`).join('')}</ul>
      <div class="room-total"><span>Room total</span><span class="display">${inr(f.total)}</span></div>
      <div class="room-actions"><button class="btn" data-folio="print" data-id="${f.id}">Statement</button><button class="btn dark" data-folio="settle" data-id="${f.id}">Checkout</button></div>`
    : `<div class="room-empty">No food orders yet.</div><button class="btn room-new" data-folio="order" data-room="${esc(f.room_no)}">+ New order for this room</button>`}
  </article>`).join('') || '<div class="empty">No rooms open. Room-service orders charged to a room appear here.</div>';
}
$('#folios').onclick = async e => {
  const b = e.target.closest('[data-folio]');
  if (!b) return;
  if (b.dataset.folio === 'order') { kind = 'room'; renderKind(); $('#ref').value = b.dataset.room; addingTo = null; renderAdding(); return show('new'); }
  const id = +b.dataset.id;
  if (b.dataset.folio === 'print') return print('folio', id);
  const f = await ask('Checkout: settle room bill', `<div class="field">Paid by<div class="pay-grid">${PAY.map(([v, l], i) =>
    `<label><input type="radio" name="mode" value="${v}" ${i ? '' : 'checked'}>${l}</label>`).join('')}</div></div>`, 'Settle & print');
  if (f) { await api(`/folios/${id}/settle`, f); print('folio', id); }
};
$('#folioForm').onsubmit = async e => {
  e.preventDefault();
  await api('/folios', Object.fromEntries(new FormData(e.target)));
  e.target.reset();
};

// ---------- reports ----------
const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
$('#rFrom').value = $('#rTo').value = today;
const KIND_NAMES = { table: 'Dine-in', room: 'Room', takeaway: 'Takeaway' };
const PAY_NAMES = { cash: 'Cash', upi: 'UPI', card: 'Card', room: 'Charged to room' };
const SWATCH = ['#1B1A17', '#E8922A', '#D6D1C7', '#8A877F'];
async function runReport() {
  const name = $('#rName').value, from = $('#rFrom').value, to = $('#rTo').value, qs = `from=${from}&to=${to}`;
  $('#rTitle').textContent = $('#rName').selectedOptions[0].text;
  const fmt = d => new Date(d + 'T12:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('#rSub').textContent = from === to ? fmt(from) : `${fmt(from)} to ${fmt(to)}`;
  $('#rCsv').href = `/api/reports/${name}?${qs}&csv=1`;
  if (name === 'bills') return renderBills(await api(`/reports/bills?${qs}`));
  if (name !== 'dayend') {
    const rows = await api(`/reports/${name}?${qs}`);
    if (!rows.length) return ($('#rOut').innerHTML = '<div class="empty">Nothing for these dates.</div>');
    const cols = Object.keys(rows[0]), money = c => ['amount', 'value', 'total'].includes(c), num = c => money(c) || c === 'qty';
    return ($('#rOut').innerHTML = `<div class="panel"><div class="scroll"><table class="data"><thead><tr>${cols.map(c => `<th class="${num(c) ? 'num' : ''}">${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr>${cols.map(c => `<td class="${num(c) ? 'num' : ''}">${money(c) ? inr(r[c]) : esc(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`);
  }
  const s = await api(`/reports/summary?${qs}`);
  const pct = r => (s.gross ? Math.round(r.total / s.gross * 100) : 0);
  const split = (rows, names) => rows.length ? `<div class="bar" role="img" aria-label="${rows.map(r => `${names[r.kind || r.pay_mode]} ${pct(r)}%`).join(', ')}">
      ${rows.map((r, i) => `<div style="flex:${r.total};background:${SWATCH[i % 4]}"></div>`).join('')}</div>
    <div>${rows.map((r, i) => `<div class="kv"><span class="sw" style="background:${SWATCH[i % 4]}"></span><span>${names[r.kind || r.pay_mode]}</span>
      <span class="r">${r.bills} ${r.bills === 1 ? 'bill' : 'bills'}</span><span class="r b">${inr0(r.total)}</span><span class="r">${pct(r)}%</span></div>`).join('')}</div>`
    : '<p class="muted">No bills yet.</p>';
  $('#rOut').innerHTML = `<div class="stats">
      <div class="stat dark"><span>Gross sales (incl. GST)</span><span class="display">${inr0(s.gross)}</span></div>
      <div class="stat"><span>Net sales (taxable)</span><span class="display">${inr0(s.net)}</span></div>
      <div class="stat"><span>Bills</span><span class="display">${s.bills}</span></div>
      <div class="stat"><span>Average bill</span><span class="display">${inr0(s.avg)}</span></div></div>
    <div class="two-up">
      <section class="panel"><h2>Sales by order type</h2>${split(s.byType, KIND_NAMES)}</section>
      <section class="panel"><div class="heading-row between"><h2>GST summary</h2><span class="muted small">${settings.gstin ? 'GSTIN ' + esc(settings.gstin) : ''}</span></div><div>
        <div class="pair"><span>Taxable value</span><span>${inr(s.net)}</span></div>
        <div class="pair"><span>CGST</span><span>${inr(s.cgst)}</span></div>
        <div class="pair"><span>SGST</span><span>${inr(s.sgst)}</span></div>
        <div class="pair total"><span>Total tax</span><span class="display">${inr(s.tax)}</span></div></div></section>
      <section class="panel"><h2>By payment</h2>${split(s.byPay, PAY_NAMES)}</section>
    </div>`;
}
function renderBills(rows) {
  if (!rows.length) return ($('#rOut').innerHTML = '<div class="empty">No bills for these dates.</div>');
  const live = rows.filter(r => r.status === 'billed');
  $('#rOut').innerHTML = `<div class="panel"><div class="heading-row between"><h2>${rows.length} bills</h2>
      <span class="muted small">${inr(live.reduce((s, r) => s + r.total, 0))} excluding void bills</span></div>
    <div class="scroll"><table class="data"><thead><tr><th>Bill</th><th>Time</th><th>For</th><th>Payment</th><th>By</th><th class="num">Total</th><th></th></tr></thead><tbody>
    ${rows.map(r => `<tr><td><b>${esc(r.bill_no)}</b></td><td>${esc(r.billed_at.slice(11, 16))}</td><td>${esc(r.for)}</td><td>${esc(PAY_NAMES[r.payment] || r.payment)}</td>
      <td>${esc(r.billed_by)}</td><td class="num">${inr(r.total)}</td>
      <td>${r.status === 'void' ? `<span class="status-void" title="${esc(r.void_reason)}">VOID</span> <span class="muted small">${esc(r.void_reason)}</span>`
        : `<button class="btn" data-print="${r.id}">Reprint</button>${role === 'owner' ? ` <button class="btn" data-void="${r.id}" data-no="${esc(r.bill_no)}">Void</button>` : ''}`}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}
$('#rOut').onclick = async e => {
  const p = e.target.closest('[data-print]');
  if (p) return print('bill', +p.dataset.print);
  const v = e.target.closest('[data-void]');
  if (!v) return;
  const f = await ask(`Void bill ${esc(v.dataset.no)}?`, `<p class="muted">The bill number stays used and the bill drops out of sales and GST totals. This can't be undone.</p>
    <label class="field">Reason<input name="reason" required placeholder="e.g. wrong items billed"></label>`, 'Void bill');
  if (f) { await api(`/orders/${+v.dataset.void}/void`, f); runReport(); }
};
$('#rForm').onsubmit = e => { e.preventDefault(); runReport(); };
$('#rName').onchange = runReport;

// ---------- settings & menu ----------
const dirty = new Set();
const catOptions = (current = '') => [...new Set([...categories(), current].filter(Boolean))].sort()
  .map(c => `<option ${c === current ? 'selected' : ''}>${esc(c)}</option>`).join('');
function renderCategorySelect() {
  const sel = $('#menuForm').elements.category, keep = sel.value;
  sel.innerHTML = catOptions() + '<option value="__new">+ New category</option>';
  sel.value = [...sel.options].some(o => o.value === keep) ? keep : categories()[0] || '__new';
  sel.onchange();
}
$('#menuForm').elements.category.onchange = () => {
  const isNew = $('#menuForm').elements.category.value === '__new';
  $('#newCatField').hidden = !isNew;
  $('#menuForm').elements.new_category.required = isNew;
};
$('#vegSeg').onclick = e => { const b = e.target.closest('[data-veg]'); if (b) { newVeg = +b.dataset.veg; press('#vegSeg', 'data-veg', newVeg); } };

function renderMenuTable() {
  if ($('#menuTable').contains(document.activeElement) || dirty.size) return; // don't wipe edits in progress
  const q = $('#menuSearch').value.trim().toLowerCase();
  const rates = {};
  menu.forEach(m => (rates[m.gst_pct] = (rates[m.gst_pct] || 0) + 1));
  const usual = +Object.keys(rates).sort((a, b) => rates[b] - rates[a])[0];
  const rows = menu.filter(m => !q || m.name.toLowerCase().includes(q) || m.category.toLowerCase().includes(q));
  $('#menuSummary').textContent = `${menu.length} dishes in ${categories().length} categories`;
  $('#menuShown').textContent = q ? `Showing ${rows.length} of ${menu.length}` : '';
  $('#menuTable').innerHTML = rows.map(m => {
    const odd = menu.length > 2 && m.gst_pct !== usual;
    return `<tr data-id="${m.id}">
      <td>${mark(m.veg)}</td>
      <td><input class="name" name="name" value="${esc(m.name)}" aria-label="Item name"></td>
      <td><select name="category" aria-label="Category">${catOptions(m.category)}</select></td>
      <td><input name="price" type="number" step="0.01" min="0" value="${m.price}" aria-label="Price"></td>
      <td><input name="gst_pct" type="number" step="0.01" min="0" max="28" value="${m.gst_pct}" aria-label="GST percent" class="${odd ? 'odd' : ''}"></td>
      <td><button type="button" role="switch" class="switch" aria-checked="${!!m.active}" aria-label="${esc(m.name)} on menu"><span></span></button></td>
    </tr>${odd ? `<tr class="warn"><td></td><td colspan="5">GST is ${m.gst_pct}% here, but most dishes are ${usual}%. Check this rate.</td></tr>` : ''}`;
  }).join('') || '<tr><td colspan="6" class="muted" style="padding: 20px">No items match.</td></tr>';
}
function markDirty(tr) {
  dirty.add(+tr.dataset.id);
  tr.classList.add('dirty');
  $('#dirtyNote').textContent = `${dirty.size} unsaved ${dirty.size === 1 ? 'change' : 'changes'}`;
  $('#saveMenu').disabled = false;
}
$('#menuTable').oninput = e => { const tr = e.target.closest('tr[data-id]'); if (tr) markDirty(tr); };
$('#menuTable').onclick = e => {
  const sw = e.target.closest('.switch');
  if (!sw) return;
  sw.setAttribute('aria-checked', String(sw.getAttribute('aria-checked') !== 'true'));
  markDirty(sw.closest('tr'));
};
$('#saveMenu').onclick = async () => {
  for (const id of dirty) {
    const tr = $(`#menuTable tr[data-id="${id}"]`), v = n => tr.querySelector(`[name=${n}]`).value;
    const m = menu.find(x => x.id === id);
    await api('/menu/' + id, { category: v('category'), name: v('name'), price: v('price'), gst_pct: v('gst_pct'),
      veg: m.veg, active: tr.querySelector('.switch').getAttribute('aria-checked') === 'true' }, 'PUT');
  }
  dirty.clear();
  $('#dirtyNote').textContent = '';
  $('#saveMenu').disabled = true;
  await refresh();
};
$('#menuSearch').oninput = () => { if (!dirty.size) renderMenuTable(); };
$('#menuForm').onsubmit = async e => {
  e.preventDefault();
  const el = e.target.elements;
  const category = el.category.value === '__new' ? el.new_category.value.trim() : el.category.value;
  await api('/menu', { category, name: el.item_name.value, price: el.price.value, gst_pct: el.gst_pct.value, veg: !!newVeg });
  menu.push({ category }); // so a new category is in the dropdown right away
  e.target.reset();
  renderCategorySelect();
  el.category.value = category; // keep category for adding the next item quickly
  el.category.onchange();
  el.item_name.focus();
};

let paper = '80';
$('#paperSeg').onclick = e => { const b = e.target.closest('[data-w]'); if (b) { paper = b.dataset.w; press('#paperSeg', 'data-w', paper); } };
async function loadSettings() {
  settings = await api('/settings');
  const el = $('#settingsForm').elements;
  for (const k of ['hotel_name', 'address', 'gstin']) el[k].value = settings[k];
  paper = settings.paper_width;
  press('#paperSeg', 'data-w', paper);
  $('#hotel').textContent = settings.hotel_name;
  document.title = settings.hotel_name;
  $('#login .display').textContent = settings.hotel_name;
  if (window.desktop) {
    const printers = await window.desktop.printers();
    $('#printer').innerHTML = '<option value="">System default</option>' +
      printers.map(p => `<option ${p.name === localStorage.printer ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  }
  renderPrintStatus();
}
$('#settingsForm').onsubmit = async e => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  body.paper_width = paper;
  await api('/settings', body, 'PUT');
  await loadSettings();
  alert('Settings saved');
};
// ---------- people & security (owner) ----------
async function loadStaff() {
  const staff = await api('/staff');
  $('#staffList').innerHTML = staff.map(s => `<div class="staff-row ${s.active ? '' : 'off'}"><b>${esc(s.name)}</b>
    <button type="button" class="btn" data-pin="${s.id}" data-name="${esc(s.name)}">Change PIN</button>
    <button type="button" role="switch" class="switch" data-staff="${s.id}" aria-checked="${!!s.active}" aria-label="${esc(s.name)} can log in"><span></span></button></div>`).join('')
    || '<p class="muted small">No staff yet. Add each person below with their own PIN.</p>';
}
$('#staffForm').onsubmit = async e => {
  e.preventDefault();
  await api('/staff', Object.fromEntries(new FormData(e.target)));
  e.target.reset();
  loadStaff();
};
$('#staffList').onclick = async e => {
  const sw = e.target.closest('[data-staff]'), pin = e.target.closest('[data-pin]');
  if (sw) { await api('/staff/' + sw.dataset.staff, { active: sw.getAttribute('aria-checked') !== 'true' }, 'PUT'); return loadStaff(); }
  if (!pin) return;
  const f = await ask(`New PIN for ${esc(pin.dataset.name)}`, `<label class="field">PIN (6–8 digits)<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{6,8}" required autocomplete="new-password"></label>
    <p class="muted small">Every device will be logged out, so the old PIN stops working everywhere.</p>`, 'Save PIN');
  if (f) { await api('/staff/' + pin.dataset.pin, f, 'PUT'); alert('PIN changed. Everyone else has been logged out.'); }
};
$('#ownerPwForm').onsubmit = async e => {
  e.preventDefault();
  const r = await api('/owner-password', Object.fromEntries(new FormData(e.target)));
  e.target.reset();
  $('#starterBanner').hidden = !r.resetFlagStillOn;
  alert(r.resetFlagStillOn ? 'Password saved, but RESET_OWNER_PASSWORD is still on in Netlify, so the starter password also works. Remove that setting.'
    : 'Password changed. Other devices have been logged out.');
};
$('#logoutAll').onclick = async () => {
  if (!confirm('Log out every phone, tablet and computer? Staff will need their PIN again.')) return;
  await api('/logout-all', {});
  alert('Done. Every other device is logged out.');
};
$('#goSecurity').onclick = () => { show('settings'); $('#security').scrollIntoView({ behavior: 'smooth' }); };

// per-device settings live in this browser/PC, not in the shared database
function renderPrintStatus() {
  const on = localStorage.autoKot === '1';
  $('#autoKot').setAttribute('aria-checked', String(on));
  $('#printStatus').textContent = (on ? 'KOTs print here' : 'KOTs don’t print here') + ` · ${settings.paper_width || 80} mm`;
}
$('#printer').onchange = e => (localStorage.printer = e.target.value);
$('#autoKot').onclick = () => { localStorage.autoKot = localStorage.autoKot === '1' ? '0' : '1'; kotAfter = null; localStorage.removeItem('kotAfter'); renderPrintStatus(); };
document.body.classList.add(window.desktop ? 'is-desktop' : 'is-browser');

// Devices with automatic KOT printing on check for new KOTs on every refresh. The last one printed is remembered on
// this device, so KOTs made while it was closed still print when it reopens (only those from the last 2 hours).
let kotAfter = localStorage.kotAfter ?? null;
const RECENT = 2 * 3600e3;
async function pollKots() {
  if (localStorage.autoKot !== '1') return;
  const r = await api('/kots' + (kotAfter == null ? '' : '?after=' + kotAfter));
  if (kotAfter != null) for (const k of r.kots)
    if (!k.created_at || Date.now() - new Date(k.created_at.replace(' ', 'T') + '+05:30') < RECENT) await print('kot', k.order_id, k.kot_no);
  localStorage.kotAfter = kotAfter = r.last;
}

// ---------- boot ----------
async function refresh() {
  [menu, orders, folios] = await Promise.all([api('/menu'), api('/orders'), api('/folios')]);
  renderCats(); renderMenu(); renderCart(); renderBoard(); renderFolios(); renderMenuTable(); renderCategorySelect();
  if (addingTo && !orders.some(o => o.id === addingTo.id)) { addingTo = null; renderAdding(); } // billed/cancelled elsewhere
}
let started = false;
async function boot() {
  try {
    const me = await api('/me');
    role = me.role;
    if (!role) return $('#login').showModal();
    document.body.classList.toggle('is-owner', role === 'owner');
    $('#who').textContent = me.name;
    $('#starterBanner').hidden = !me.starterPassword;
    if (role === 'owner') loadStaff().catch(() => {});
    await loadSettings();
    await refresh();
    await pollKots();
    if (!$('#reports').hidden) runReport().catch(() => {});
  } catch { return; }
  if (started) return;
  started = true;
  // ponytail: polling every 5 s (serverless functions can't hold live connections); fine for one hotel
  setInterval(() => { if (!document.hidden || localStorage.autoKot === '1') refresh().then(pollKots).catch(() => {}); }, 5000);
}
$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  try {
    await api('/login', { secret: e.target.elements.secret.value });
    e.target.reset();
    $('#loginErr').textContent = '';
    $('#login').close();
    boot();
  } catch (err) { $('#loginErr').textContent = err.message; }
};
$('#logout').onclick = async () => { await api('/logout', {}); location.reload(); };
renderKind();
show(location.hash.slice(1) || 'new');
boot();

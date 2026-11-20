// UI: plain DOM, talks only to /api, so the same file works in Electron, a LAN browser, or a cloud deploy.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '₹' + (+n || 0).toFixed(2);
const label = o => (o.kind === 'takeaway' ? 'Takeaway' : `${o.kind === 'room' ? 'Room' : 'Table'} ${o.ref}`);
const PAY_OPTS = '<option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option>';

let menu = [], orders = [], folios = [], settings = {}, addingTo = null;
const cart = new Map(); // menu_id -> qty

async function api(url, body, method = body ? 'POST' : 'GET') {
  const r = await fetch('/api' + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== '/login') { $('#login').showModal(); throw new Error('Login required'); }
  if (!r.ok) { if (url !== '/login') alert(data.error || 'Request failed'); throw new Error(data.error || 'Request failed'); }
  return data;
}

// Desktop prints silently to the thermal printer; a browser opens the ticket and shows its print dialog.
async function print(type, id, kot = '') {
  if (window.desktop) {
    const r = await window.desktop.print(type, id, kot);
    if (r !== 'ok') alert('Print failed: ' + r);
  } else {
    window.open(`/ticket.html?type=${type}&id=${id}&kot=${kot}&auto=1`, '_blank', 'width=420,height=640');
  }
}

// Small modal form (window.prompt does not work in Electron). Resolves to the form values, or null if closed.
function ask(title, fields, okText = 'OK') {
  const d = $('#dlg');
  d.innerHTML = `<form method="dialog"><h3>${title}</h3>${fields}
    <menu><button value="" formnovalidate>Close</button><button value="ok" class="primary">${okText}</button></menu></form>`;
  d.returnValue = '';
  d.showModal();
  return new Promise(res => (d.onclose = () => res(d.returnValue === 'ok' ? Object.fromEntries(new FormData(d.querySelector('form'))) : null)));
}

// ---------- tabs ----------
function show(tab) {
  document.querySelectorAll('main > section').forEach(s => (s.hidden = s.id !== tab));
  document.querySelectorAll('nav [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  history.replaceState(null, '', '#' + tab);
}
document.querySelectorAll('nav [data-tab]').forEach(b => (b.onclick = () => show(b.dataset.tab)));

// ---------- new order ----------
function renderMenu() {
  const q = $('#search').value.toLowerCase(), groups = {};
  for (const m of menu) if (m.active && m.name.toLowerCase().includes(q)) (groups[m.category || 'Other'] ||= []).push(m);
  $('#menuGrid').innerHTML = Object.entries(groups).map(([c, items]) => `<h4>${esc(c)}</h4><div class="tiles">${items.map(m =>
    `<button class="tile ${m.veg ? 'veg' : 'nonveg'}" data-add="${m.id}">${esc(m.name)}<small>${money(m.price)}</small></button>`).join('')}</div>`).join('')
    || '<p class="muted">No menu items yet. Add them in Settings.</p>';
}
function renderCart() {
  let sum = 0;
  const lines = [...cart].map(([id, qty]) => {
    const m = menu.find(x => x.id === id);
    if (!m) return '';
    sum += m.price * qty;
    return `<div class="line"><span>${esc(m.name)}</span><span class="qty"><button data-q="${id}" data-d="-1" aria-label="Less">−</button>${qty}<button data-q="${id}" data-d="1" aria-label="More">+</button></span></div>`;
  }).join('');
  $('#cart').innerHTML = (lines || '<p class="muted">Tap menu items to add them.</p>') + `<div class="line total"><b>Subtotal</b><b>${money(sum)}</b></div>`;
}
function renderAdding() {
  $('#adding').hidden = !addingTo;
  $('#orderHead').hidden = !!addingTo;
  $('#note').hidden = !!addingTo;
  if (addingTo) $('#addingLabel').textContent = `${label(addingTo)} (order #${addingTo.id})`;
  $('#saveOrder').textContent = addingTo ? 'Add & send KOT' : 'Save & send KOT';
}
$('#search').oninput = renderMenu;
$('#kind').onchange = () => ($('#ref').hidden = $('#kind').value === 'takeaway');
$('#menuGrid').onclick = e => {
  const b = e.target.closest('[data-add]');
  if (!b) return;
  const id = +b.dataset.add;
  cart.set(id, (cart.get(id) || 0) + 1);
  renderCart();
};
$('#cart').onclick = e => {
  const b = e.target.closest('[data-q]');
  if (!b) return;
  const id = +b.dataset.q, q = cart.get(id) + +b.dataset.d;
  q > 0 ? cart.set(id, q) : cart.delete(id);
  renderCart();
};
$('#cancelAdd').onclick = () => { addingTo = null; renderAdding(); };
$('#saveOrder').onclick = async () => {
  if (!cart.size) return alert('Cart is empty');
  const items = [...cart].map(([menu_id, qty]) => ({ menu_id, qty }));
  const r = addingTo
    ? await api(`/orders/${addingTo.id}/items`, { items })
    : await api('/orders', { kind: $('#kind').value, ref: $('#ref').value, note: $('#note').value, items });
  if (!window.desktop && localStorage.kotHere === '1') print('kot', r.id, r.kot_no);
  cart.clear();
  addingTo = null;
  $('#ref').value = $('#note').value = '';
  renderCart();
  renderAdding();
  show('live');
  refresh();
};

// ---------- live board ----------
function card(o) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(o.created_at.replace(' ', 'T'))) / 60000));
  const next = { new: 'Preparing', preparing: 'Served' }[o.status];
  return `<div class="card">
    <div class="line"><b>${esc(label(o))}</b><small class="muted">#${o.id} · ${mins} min</small></div>
    <ul>${o.items.map(i => `<li>${i.qty} × ${esc(i.name)}</li>`).join('')}</ul>${o.note ? `<p class="note">${esc(o.note)}</p>` : ''}
    <div class="actions">
      ${next ? `<button data-act="next" data-id="${o.id}">→ ${next}</button>` : ''}
      <button data-act="add" data-id="${o.id}">+ Items</button>
      <button data-act="kot" data-id="${o.id}">KOT</button>
      <button data-act="cancel" data-id="${o.id}">Cancel</button>
      <button data-act="bill" data-id="${o.id}" class="primary">Bill ${money(o.totals.total)}</button>
    </div></div>`;
}
function renderBoard() {
  for (const s of ['new', 'preparing', 'served']) $('#col-' + s).innerHTML = orders.filter(o => o.status === s).map(card).join('') || '<p class="muted">None</p>';
  $('#liveCount').textContent = orders.length || '';
}
$('#live').onclick = async e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const o = orders.find(x => x.id === +b.dataset.id);
  if (!o) return;
  const act = b.dataset.act;
  if (act === 'next') await api(`/orders/${o.id}/status`, { status: o.status === 'new' ? 'preparing' : 'served' });
  if (act === 'kot') print('kot', o.id);
  if (act === 'add') { addingTo = o; renderAdding(); show('new'); }
  if (act === 'cancel') {
    const f = await ask(`Cancel ${esc(label(o))}?`, '<label>Reason <input name="reason" required></label>', 'Cancel order');
    if (f) await api(`/orders/${o.id}/status`, { status: 'cancelled', reason: f.reason });
  }
  if (act === 'bill') {
    const t = o.totals;
    const f = await ask(`Bill: ${esc(label(o))}`, `
      <p>Subtotal ${money(t.subtotal)} · GST ${money(t.tax)} · <b>Total ${money(t.total)}</b> (before discount)</p>
      <label>Discount ₹ <input name="discount" type="number" min="0" max="${t.subtotal}" step="0.01" value="0"></label>
      <label>Payment <select name="pay_mode">${PAY_OPTS}<option value="room">Charge to room</option></select></label>
      ${o.kind === 'room' ? '' : '<label>Room no. (only if charging to a room) <input name="room_no"></label>'}`, 'Bill & print');
    if (!f) return;
    const billed = await api(`/orders/${o.id}/bill`, f);
    print('bill', billed.id);
  }
};

// ---------- rooms ----------
function renderFolios() {
  $('#folios').innerHTML = folios.map(f => `<div class="card">
    <div class="line"><b>Room ${esc(f.room_no)}</b><small class="muted">since ${esc(f.opened_at)}</small></div>
    ${f.guest ? `<div>${esc(f.guest)}</div>` : ''}
    <ul>${f.orders.map(o => `<li>${esc(o.bill_no)}: ${money(o.total)}</li>`).join('') || '<li class="muted">No charges yet</li>'}</ul>
    <div class="line total"><b>Total</b><b>${money(f.total)}</b></div>
    <div class="actions"><button data-folio="print" data-id="${f.id}">Statement</button>
      <button data-folio="settle" data-id="${f.id}" class="primary">Checkout</button></div></div>`).join('')
    || '<p class="muted">No open room bills. Room-service orders charged to a room appear here.</p>';
}
$('#folios').onclick = async e => {
  const b = e.target.closest('[data-folio]');
  if (!b) return;
  const id = +b.dataset.id;
  if (b.dataset.folio === 'print') return print('folio', id);
  const f = await ask('Checkout: settle room bill', `<label>Paid by <select name="mode">${PAY_OPTS}</select></label>`, 'Settle & print');
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
const reportUrl = () => `/reports/${$('#rName').value}?from=${$('#rFrom').value}&to=${$('#rTo').value}`;
const setCsv = () => ($('#rCsv').href = '/api' + reportUrl() + '&csv=1');
['#rName', '#rFrom', '#rTo'].forEach(s => ($(s).onchange = setCsv));
setCsv();
$('#rShow').onclick = async () => {
  const rows = await api(reportUrl());
  if (!rows.length) return ($('#rOut').innerHTML = '<p class="muted">No data for these dates.</p>');
  const cols = Object.keys(rows[0]);
  $('#rOut').innerHTML = `<div class="scroll"><table><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr>${rows.map(r =>
    `<tr>${cols.map(c => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('')}</table></div>`;
};

// ---------- settings & menu ----------
function renderMenuTable() {
  if ($('#menuTable').contains(document.activeElement)) return; // don't wipe a row someone is editing
  $('#menuTable').innerHTML = '<tr><th>Category</th><th>Name</th><th>Price</th><th>GST %</th><th>Veg</th><th>Active</th><th></th></tr>' +
    menu.map(m => `<tr data-id="${m.id}">
      <td><input name="category" value="${esc(m.category)}" aria-label="Category"></td>
      <td><input name="name" value="${esc(m.name)}" aria-label="Name"></td>
      <td><input name="price" type="number" step="0.01" min="0" value="${m.price}" class="short" aria-label="Price"></td>
      <td><input name="gst_pct" type="number" step="0.01" min="0" max="28" value="${m.gst_pct}" class="short" aria-label="GST %"></td>
      <td><input name="veg" type="checkbox" ${m.veg ? 'checked' : ''} aria-label="Veg"></td>
      <td><input name="active" type="checkbox" ${m.active ? 'checked' : ''} aria-label="Active"></td>
      <td><button data-save>Save</button></td></tr>`).join('');
}
$('#menuTable').onclick = async e => {
  if (!e.target.matches('[data-save]')) return;
  const tr = e.target.closest('tr'), v = n => tr.querySelector(`[name=${n}]`);
  e.target.blur();
  await api('/menu/' + tr.dataset.id, { category: v('category').value, name: v('name').value, price: v('price').value,
    gst_pct: v('gst_pct').value, veg: v('veg').checked, active: v('active').checked }, 'PUT');
};
$('#menuForm').onsubmit = async e => {
  e.preventDefault();
  const el = e.target.elements;
  await api('/menu', { category: el.category.value, name: el.item.value, price: el.price.value, gst_pct: el.gst_pct.value, veg: el.veg.checked });
  const cat = el.category.value;
  e.target.reset();
  el.category.value = cat; // keep category for adding the next item quickly
  el.item.focus();
};

async function loadSettings() {
  const [s, info] = await Promise.all([api('/settings'), api('/info')]);
  settings = s;
  const el = $('#settingsForm').elements;
  for (const k of ['hotel_name', 'address', 'gstin', 'paper_width']) el[k].value = s[k];
  el.auto_kot.checked = s.auto_kot === '1';
  $('#settingsForm fieldset').disabled = !info.local;
  $('#hotel').textContent = s.hotel_name;
  document.title = s.hotel_name;
  $('#lan').innerHTML = !info.local ? 'Settings can only be changed on the counter PC.'
    : s.has_pin ? `Phones and tablets on this Wi‑Fi can open: <b>${info.lan.map(esc).join('</b> or <b>') || 'no network found'}</b>`
    : 'Set a LAN PIN to let phones and tablets on this Wi‑Fi use the app.';
  if (window.desktop) {
    const printers = await window.desktop.printers();
    el.printer.innerHTML = '<option value="">System default</option>' +
      printers.map(p => `<option ${p.name === s.printer ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  }
}
$('#settingsForm').onsubmit = async e => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  body.auto_kot = e.target.elements.auto_kot.checked ? '1' : '0';
  if (!body.pin) delete body.pin;
  await api('/settings', body, 'PUT');
  e.target.elements.pin.value = '';
  await loadSettings();
  alert('Settings saved');
};
$('#kotHere').checked = localStorage.kotHere === '1';
$('#kotHere').onchange = e => (localStorage.kotHere = e.target.checked ? '1' : '0');
document.body.classList.add(window.desktop ? 'is-desktop' : 'is-browser');

// ---------- boot ----------
async function refresh() {
  [menu, orders, folios] = await Promise.all([api('/menu'), api('/orders'), api('/folios')]);
  renderMenu(); renderCart(); renderBoard(); renderFolios(); renderMenuTable();
  if (addingTo && !orders.some(o => o.id === addingTo.id)) { addingTo = null; renderAdding(); } // order was billed/cancelled elsewhere
}
let started = false;
async function boot() {
  try { await loadSettings(); await refresh(); } catch { return; }
  if (started) return;
  started = true;
  new EventSource('/api/events').onmessage = () => refresh().catch(() => {});
  setInterval(() => refresh().catch(() => {}), 60000); // keeps the "x min" ages fresh
}
$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  try {
    await api('/login', { pin: e.target.elements.pin.value });
    $('#login').close();
    boot();
  } catch (err) { $('#loginErr').textContent = err.message; }
};
show(location.hash.slice(1) || 'new');
boot();

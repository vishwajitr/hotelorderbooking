// Self-check of the business rules on an in-memory Postgres (PGlite): `npm test`
const assert = require('assert');
const { openDb, fy, stamp } = require('./db');
const { pgliteConn } = require('./local-db');

(async () => {
  assert.strictEqual(fy('2027-03-31 23:59:59'), 'FY26-27');
  assert.strictEqual(fy('2027-04-01 00:00:00'), 'FY27-28');
  assert.strictEqual(stamp(new Date('2026-11-20T18:45:00Z')), '2026-11-21 00:15:00'); // UTC server, IST hotel

  const db = await openDb(await pgliteConn());
  const tea = await db.addMenuItem({ name: 'Tea', price: 20, gst_pct: 5 });
  const dosa = await db.addMenuItem({ name: 'Dosa', price: 100, gst_pct: 5, category: 'South Indian' });
  await assert.rejects(db.addMenuItem({ name: '', price: 10 }), /needs a name/);
  await assert.rejects(db.createOrder({ kind: 'table', items: [{ menu_id: tea.id, qty: 1 }] }), /table number/);

  const k = await db.kots(); // device starts watching for KOTs
  let r = await db.createOrder({ kind: 'table', ref: '4', items: [{ menu_id: tea.id, qty: 2 }] });
  assert.strictEqual(r.kot_no, 1);
  r = await db.addItems(r.id, [{ menu_id: dosa.id, qty: 1 }]);
  assert.strictEqual(r.kot_no, 2);
  assert.deepStrictEqual((await db.kots(k.last)).kots.map(({ order_id, kot_no }) => [order_id, kot_no]), [[r.id, 1], [r.id, 2]]);

  await db.updateMenuItem(dosa.id, { name: 'Dosa', price: 999, gst_pct: 5 }); // must not change the existing order
  await assert.rejects(db.setStatus(r.id, 'served'), /Cannot move/);
  await db.setStatus(r.id, 'preparing');
  await assert.rejects(db.bill(r.id, { discount: 500, pay_mode: 'cash' }), /Discount/);
  // subtotal 140, discount 14, taxable 126, GST 5% = 6.30, total 132.30
  let o = await db.bill(r.id, { discount: 14, pay_mode: 'upi' }, new Date(2027, 2, 31, 12));
  assert.deepStrictEqual([o.subtotal, o.tax, o.total, o.bill_no], [140, 6.3, 132.3, 'FY26-27/0001']);
  assert.deepStrictEqual([o.totals.cgst, o.totals.sgst], [3.15, 3.15]);
  await assert.rejects(db.bill(r.id, { pay_mode: 'cash' }), /closed/);

  // room service, charged to the room; new financial year restarts numbering
  r = await db.createOrder({ kind: 'room', ref: '101', items: [{ menu_id: tea.id, qty: 1 }] });
  o = await db.bill(r.id, { pay_mode: 'room' }, new Date(2027, 3, 1, 12));
  assert.strictEqual(o.bill_no, 'FY27-28/0001');
  const r2 = await db.createOrder({ kind: 'room', ref: '101', items: [{ menu_id: dosa.id, qty: 1 }] });
  await assert.rejects(db.settleFolio(o.folio_id, 'cash'), /unbilled/);
  await db.bill(r2.id, { pay_mode: 'room' }, new Date(2027, 3, 1, 12));
  const f = await db.folio(o.folio_id);
  assert.strictEqual(f.orders.length, 2);
  assert.strictEqual(f.total, 1069.95); // 21 + 1048.95
  await db.settleFolio(f.id, 'cash');
  assert.strictEqual((await db.openFolios()).length, 0);

  const c = await db.createOrder({ kind: 'takeaway', items: [{ menu_id: tea.id, qty: 1 }] });
  await assert.rejects(db.setStatus(c.id, 'cancelled', ''), /reason/);
  await db.setStatus(c.id, 'cancelled', 'customer left');
  assert.strictEqual((await db.activeOrders()).length, 0);
  assert.strictEqual((await db.report('items', '2027-04-01', '2027-04-01')).length, 2);
  assert.strictEqual((await db.report('dayend', '2027-03-31', '2027-03-31'))[0].total, 132.3);
  const sum = await db.report('summary', '2027-03-31', '2027-04-01');
  assert.deepStrictEqual([sum.bills, sum.gross, sum.net, sum.tax, sum.cgst, sum.sgst], [3, 1202.25, 1145, 57.25, 28.63, 28.62]);
  assert.deepStrictEqual(sum.byType.map(r => [r.kind, r.bills]), [['room', 2], ['table', 1]]);
  assert.strictEqual((await db.report('cancelled', stamp().slice(0, 10), stamp().slice(0, 10)))[0].value, 20);

  // who did it, voiding a bill (number kept, drops out of totals), staff, session version, backup
  const v1 = await db.createOrder({ kind: 'table', ref: '9', items: [{ menu_id: tea.id, qty: 1 }], by: 'Ravi' });
  const vb = await db.bill(v1.id, { pay_mode: 'cash', by: 'Ravi' }, new Date(2027, 3, 2, 12));
  assert.deepStrictEqual([vb.created_by, vb.billed_by, vb.bill_no], ['Ravi', 'Ravi', 'FY27-28/0003']);
  await assert.rejects(db.voidBill(v1.id, ''), /reason/);
  const vd = await db.voidBill(v1.id, 'wrong table', 'Owner');
  assert.deepStrictEqual([vd.status, vd.bill_no, vd.voided_by], ['void', 'FY27-28/0003', 'Owner']);
  assert.strictEqual((await db.report('summary', '2027-04-02', '2027-04-02')).bills, 0);
  assert.strictEqual((await db.report('bills', '2027-04-02', '2027-04-02'))[0].status, 'void');
  const v2 = await db.createOrder({ kind: 'takeaway', items: [{ menu_id: tea.id, qty: 1 }] });
  assert.strictEqual((await db.bill(v2.id, { pay_mode: 'upi' }, new Date(2027, 3, 2, 13))).bill_no, 'FY27-28/0004'); // no reuse
  await assert.rejects(db.voidBill(r2.id, 'x'), /already settled/); // room bill already checked out

  const ravi = await db.addStaff('Ravi', 'salt:hash');
  assert.deepStrictEqual((await db.staffList()).map(s => s.name), ['Ravi']);
  await db.updateStaff(ravi.id, { active: false });
  assert.strictEqual((await db.staffHashes()).length, 0);
  const ver = await db.sessionVersion();
  assert.strictEqual(await db.bumpSessions(), ver + 1);
  const dump = await db.backup();
  assert.ok(dump.tables.orders.length > 5 && dump.tables.staff.every(s => !('pin_hash' in s)));

  // menu import skips dishes already on the menu
  assert.deepStrictEqual(await db.importMenu([{ name: 'tea', price: 25 }, { category: 'Sweets', name: 'Jalebi', price: 40, veg: 1 }]), { added: 1, skipped: 1 });
  await assert.rejects(db.importMenu([{ name: '', price: 1 }]), /needs a name/);

  // categories: empty ones allowed, no duplicates, rename moves dishes, can't remove one with dishes
  await db.addCategory('Chinese');
  await assert.rejects(db.addCategory('chinese'), /already exists/);
  await assert.rejects(db.addCategory('sweets'), /already exists/); // already used by a dish (Jalebi)
  assert.deepStrictEqual((await db.categoryList()).find(c => c.name === 'Chinese'), { name: 'Chinese', dishes: 0 });
  await db.renameCategory('Sweets', 'Mithai');
  assert.strictEqual((await db.menu()).find(m => m.name === 'Jalebi').category, 'Mithai');
  await assert.rejects(db.deleteCategory('Mithai'), /still has 1 dish/);
  await db.deleteCategory('Chinese');
  assert.ok(!(await db.categoryList()).some(c => c.name === 'Chinese'));

  // login lockout after 5 wrong attempts
  for (let i = 0; i < 4; i++) await db.loginFailed('1.2.3.4');
  assert.strictEqual(await db.loginBlocked('1.2.3.4'), false);
  await db.loginFailed('1.2.3.4');
  assert.strictEqual(await db.loginBlocked('1.2.3.4'), true);

  console.log('db self-check ok');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

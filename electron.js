// Desktop app: runs the same server inside Electron (so this PC is the hotel's LAN server) and adds silent thermal printing.
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { start } = require('./server');

let srv, win;

// Load the ticket in a hidden window, wait until it has rendered, then print without a dialog.
async function print(type, id, kot) {
  if (!['kot', 'bill', 'folio'].includes(type)) return 'unknown ticket type';
  const s = srv.db.settings();
  const w = new BrowserWindow({ show: false });
  try {
    const title = new Promise(r => w.webContents.on('page-title-updated', (e, t) => t !== 'ticket' && r(t)));
    await w.loadURL(`http://127.0.0.1:${srv.port}/ticket.html?type=${type}&id=${+id}&kot=${+kot || ''}`);
    const t = await Promise.race([title, new Promise(r => setTimeout(() => r('error: ticket timed out'), 10000))]);
    if (t !== 'ready') return t.replace(/^error: /, '');
    return await new Promise(r => w.webContents.print(
      { silent: true, deviceName: s.printer || undefined, margins: { marginType: 'none' } },
      (ok, err) => r(ok ? 'ok' : err || 'failed')));
  } finally {
    w.destroy();
  }
}

app.whenReady().then(async () => {
  try {
    srv = await start(path.join(app.getPath('userData'), 'hotel.db'), +process.env.PORT || 4600);
  } catch (e) {
    dialog.showErrorBox('Hotel Orders could not start', e.code === 'EADDRINUSE' ? 'Port 4600 is in use. Is the app already open?' : e.message);
    return app.quit();
  }
  win = new BrowserWindow({ width: 1280, height: 820, title: 'Hotel Orders', webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  win.loadURL(`http://127.0.0.1:${srv.port}`);

  // KOTs print here no matter which device (counter, waiter phone) created the order.
  srv.events.on('kot', async ({ id, kot_no }) => {
    if (srv.db.settings().auto_kot !== '1') return;
    const r = await print('kot', id, kot_no).catch(e => e.message);
    console.log(`KOT #${kot_no} order #${id}: ${r}`);
    if (r !== 'ok') dialog.showMessageBox(win, { type: 'error', message: `KOT #${kot_no} for order #${id} did not print`, detail: String(r) });
  });
});

ipcMain.handle('print', (e, type, id, kot) => print(type, id, kot));
ipcMain.handle('printers', e => e.sender.getPrintersAsync());
app.on('window-all-closed', () => app.quit());

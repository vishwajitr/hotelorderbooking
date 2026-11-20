// Desktop app: opens the hotel's site (Netlify) in a window and adds silent printing to the thermal printer.
// Site address: saved per PC in config.json (changeable from the menu), else HOTEL_URL, else "hotelUrl" in package.json.
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const fs = require('fs');
const path = require('path');

const configFile = () => path.join(app.getPath('userData'), 'config.json');
const readConfig = () => { try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return {}; } };
const siteUrl = () => (readConfig().url || process.env.HOTEL_URL || require('./package.json').hotelUrl || '').replace(/\/$/, '');
let win;

// Load the ticket in a hidden window (same login cookie as the main window), wait until it has rendered, then print without a dialog.
async function print(type, id, kot, printer) {
  if (!['kot', 'bill', 'folio'].includes(type)) return 'unknown ticket type';
  const w = new BrowserWindow({ show: false });
  try {
    const title = new Promise(r => w.webContents.on('page-title-updated', (e, t) => t !== 'ticket' && r(t)));
    await w.loadURL(`${siteUrl()}/ticket.html?type=${type}&id=${+id}&kot=${+kot || ''}`);
    const t = await Promise.race([title, new Promise(r => setTimeout(() => r('error: ticket timed out'), 15000))]);
    if (t !== 'ready') return t.replace(/^error: /, '');
    return await new Promise(r => w.webContents.print(
      { silent: true, deviceName: printer || undefined, margins: { marginType: 'none' } },
      (ok, err) => r(ok ? 'ok' : err || 'failed')));
  } catch (e) {
    return e.message;
  } finally {
    w.destroy();
  }
}

function openSetup() {
  const s = new BrowserWindow({ width: 520, height: 360, parent: win, modal: !!win, title: 'Hotel site address',
    webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  s.setMenu(null);
  s.loadFile(path.join(__dirname, 'setup.html'));
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'Hotel', submenu: [
      { label: 'Change site address…', click: openSetup },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win?.loadURL(siteUrl()) },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { role: 'editMenu' }, { role: 'viewMenu' },
  ]));
  win = new BrowserWindow({ width: 1280, height: 820, title: 'Hotel Orders', webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  win.webContents.on('did-fail-load', async (e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = navigation replaced, not a real failure
    const { response } = await dialog.showMessageBox(win, { type: 'error', buttons: ['Retry', 'Change address', 'Quit'],
      message: 'Cannot reach the hotel site', detail: `${siteUrl()}\n${desc}\nCheck the internet connection, or the site address.` });
    if (response === 0) win.loadURL(siteUrl());
    else if (response === 1) openSetup();
    else app.quit();
  });
  siteUrl() ? win.loadURL(siteUrl()) : openSetup();
});

// Only the local setup page may change the address, never the remote site loaded in the main window.
const fromSetup = e => e.senderFrame?.url?.startsWith('file://');
ipcMain.handle('get-url', e => (fromSetup(e) ? siteUrl() : null));
ipcMain.handle('set-url', (e, url) => {
  if (!fromSetup(e)) return 'not allowed';
  try {
    const u = new URL(String(url).trim());
    if (!/^https?:$/.test(u.protocol)) return 'Use an address starting with https://';
    fs.writeFileSync(configFile(), JSON.stringify({ ...readConfig(), url: u.origin }, null, 2));
    BrowserWindow.fromWebContents(e.sender)?.close();
    win.loadURL(u.origin);
    return 'ok';
  } catch { return 'That is not a valid web address'; }
});
ipcMain.handle('print', (e, type, id, kot, printer) => print(type, id, kot, printer));
ipcMain.handle('printers', e => e.sender.getPrintersAsync());
app.on('window-all-closed', () => app.quit());

// Desktop app: opens the hotel's cloud site (Netlify) in a window and adds silent printing to the thermal printer.
// The site address is "hotelUrl" in package.json; HOTEL_URL overrides it (e.g. http://localhost:4600 for local dev).
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');

const HOTEL_URL = (process.env.HOTEL_URL || require('./package.json').hotelUrl || '').replace(/\/$/, '');

// Load the ticket in a hidden window (same login cookie as the main window), wait until it has rendered, then print without a dialog.
async function print(type, id, kot, printer) {
  if (!['kot', 'bill', 'folio'].includes(type)) return 'unknown ticket type';
  const w = new BrowserWindow({ show: false });
  try {
    const title = new Promise(r => w.webContents.on('page-title-updated', (e, t) => t !== 'ticket' && r(t)));
    await w.loadURL(`${HOTEL_URL}/ticket.html?type=${type}&id=${+id}&kot=${+kot || ''}`);
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

app.whenReady().then(() => {
  if (!HOTEL_URL) {
    dialog.showErrorBox('Hotel Orders', 'No hotel site address set (hotelUrl in package.json).');
    return app.quit();
  }
  const win = new BrowserWindow({ width: 1280, height: 820, title: 'Hotel Orders', webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  win.webContents.on('did-fail-load', async (e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = navigation replaced, not a real failure
    const { response } = await dialog.showMessageBox(win, { type: 'error', buttons: ['Retry', 'Quit'],
      message: 'Cannot reach the hotel site', detail: `${HOTEL_URL}\n${desc}\nCheck the internet connection.` });
    response === 0 ? win.loadURL(HOTEL_URL) : app.quit();
  });
  win.loadURL(HOTEL_URL);
});

ipcMain.handle('print', (e, type, id, kot, printer) => print(type, id, kot, printer));
ipcMain.handle('printers', e => e.sender.getPrintersAsync());
app.on('window-all-closed', () => app.quit());

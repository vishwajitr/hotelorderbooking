# Hotel Orders

Order taking, kitchen tickets (KOT), GST bills, room service charged to rooms, and day-end reports for one hotel.
It runs as a website on Netlify (any phone, tablet or PC) and as a desktop app (Windows/Mac) that prints silently to a thermal printer.

Live site: https://hotelorderbooking.netlify.app (deploys automatically on every push to `main`).

---

## For the hotel: daily use

| Who | Logs in with | Can |
|---|---|---|
| Owner | Owner password | Everything, plus menu, staff, hotel details, void bills, backups |
| Staff | Their own 6–8 digit PIN | Take orders, send KOTs, bill, rooms, reports |

- **New order**: pick Table / Room / Takeaway, tap dishes, **Save & send KOT**.
- **Live**: move tickets New → Preparing → Served, add items (prints a new KOT with only the new items), **Bill**.
- **Bill**: shows a preview; enter discount and payment (Cash / UPI / Card / Charge to room). Nothing is billed until **Bill & print**.
- **Rooms**: room-service bills collect on the room; **Checkout** settles them and prints a statement.
- **Reports**: day-end summary (sales, GST, by order type and payment), item-wise sales, bill register, cancelled orders, CSV download.
- A wrong bill is **voided** by the owner (Reports → Bill register → Void). Its number stays used, as GST requires, and it drops out of totals.

### First-time setup (owner)
1. Log in with the starter owner password you were given, then **Settings → People & security → Owner password**: set your own (8+ characters). The starter password stops working.
2. **Settings → People & security → Staff**: add each person with their own PIN. Switching someone off logs them out immediately.
3. **Settings → Hotel & bills**: hotel name, address and GSTIN (printed on every bill), receipt paper width (80 or 58 mm).
4. **Settings → Menu**: dishes, prices, GST %, veg/non-veg, on/off.
5. On the computer next to the kitchen printer: **Settings → This device** → choose the printer, turn on **Print KOTs automatically on this device**. Do this on one device only, or KOTs print twice.
6. **Settings → People & security → Download backup** once a week; keep the file somewhere safe.

### Good to know
- It needs internet. Keep a mobile hotspot as backup.
- "This device" settings (printer, auto-print) live in that browser/PC. A new PC or cleared browser data means setting them again.
- The KOT printer device must have the app open. KOTs made while it was closed print when it reopens (last 2 hours only).
- In a normal browser every print shows a print dialog. The desktop app prints without one. For a kitchen PC using Chrome, start Chrome with `--kiosk-printing` to skip the dialog.
- 5 wrong PIN/password tries lock **that device** for 15 minutes (30 from one internet connection lock that connection).
- **Log out all devices** (People & security) signs everyone out. It also happens automatically when a PIN or the owner password changes.
- Bill numbers run per Indian financial year: `FY26-27/0001`, restarting each April. Times are India time.

---

## Desktop app

Installers: `npm run dist` builds `dist/Hotel Orders Setup 1.0.0.exe` (Windows x64) and `.dmg` files for Apple Silicon and Intel Macs.

- Opens the site in `hotelUrl` (package.json). Each PC can change it: menu **Hotel → Change site address…**, also offered when the site can't be reached.
- Installers are **not code-signed**, so the first install shows a warning: Windows "More info → Run anyway", Mac right-click → Open. Signing needs an Apple Developer account and a Windows code-signing certificate (paid).
- No auto-update: install new versions by hand on each PC. (Can be added later with electron-updater and GitHub Releases.)

---

## For the developer

```bash
nvm use                                   # Node 22 (see .nvmrc)
npm install
npm test                                  # business rules on an in-memory Postgres (PGlite)
OWNER_PASSWORD=devpassword npm run serve  # http://localhost:4600, data in ./.data
HOTEL_URL=http://localhost:4600 npm start # desktop app against the local server
```

| File | What |
|---|---|
| `db.js` | Postgres schema and all business rules |
| `server.js` | Express API: logins, roles, sessions, routes |
| `netlify/functions/api.mjs` | Netlify Function wrapping the API |
| `dev.js`, `local-db.js` | local server on PGlite |
| `public/` | the UI (`app.js`, `style.css`) and `ticket.html` (KOT, bill, room statement) |
| `electron.js`, `preload.js`, `setup.html` | desktop app |

### Netlify settings (Site configuration → Environment variables)
| Variable | Purpose |
|---|---|
| `OWNER_PASSWORD` | Starter owner password, used until the owner sets their own in the app |
| `SESSION_SECRET` | Random string that signs logins. Changing it logs everyone out |
| `RESET_OWNER_PASSWORD` | Set to `true` and redeploy if the owner forgets their password: `OWNER_PASSWORD` works again. Remove it afterwards |
| `HOTEL_TZ` | Optional, default `Asia/Kolkata` |

The database is Netlify Database (Postgres), enabled by the `@netlify/database` package; Netlify supplies its address.

### Handing over ownership
1. **Netlify**: transfer the site to the hotel's Netlify account (Site configuration → General → Transfer project), or invite them to the team. The database moves with the site.
2. **GitHub**: transfer the repository (Settings → Transfer ownership) or give the new developer access, then reconnect it in Netlify if needed.
3. **Passwords**: the owner sets their own password in the app. Remove any starter password from `OWNER_PASSWORD` afterwards, or leave it as recovery (only used with `RESET_OWNER_PASSWORD=true`).
4. Change `SESSION_SECRET` after the transfer to sign out every old login.
5. Give the hotel the desktop installers and this README.

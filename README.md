# Hotel Orders

Order booking for a hotel restaurant: table, room and takeaway orders, kitchen tickets (KOT), GST bills, charge-to-room with checkout, and day-end reports.
One codebase runs as a **desktop app** (Windows/Mac, silent thermal printing) and a **web app** (any phone or tablet on the hotel Wi‑Fi).

## Run
```bash
npm install
npm start          # desktop app (Electron)
npm run serve      # web only: http://localhost:4600
npm test           # database self-check
npm run dist       # build .dmg and .exe installers into dist/
```

## How it fits together
- `server.js`: JSON API, PIN login for LAN devices, live updates (Server-Sent Events). The desktop app runs this same server inside itself, so the counter PC is the hotel's server.
- `db.js`: SQLite (sql.js) with all the business rules. The desktop app keeps its data in the app's user-data folder as `hotel.db`; `npm run serve` keeps it in `./hotel.db`.
- `public/`: the UI and `ticket.html` (KOT, bill, room statement, sized for 58/80 mm paper).
- `electron.js`: silent printing. KOTs print on the counter PC whichever device placed the order.

## Other devices on the Wi‑Fi
Set a LAN PIN in **Settings** on the counter PC. The app then shows the address phones and tablets should open, for example `http://192.168.1.20:4600`.
LAN access stays off until a PIN is set, and settings can only be changed on the counter PC.

## Printing
- Desktop: pick the thermal printer in Settings. KOTs and bills print without a dialog.
- Browser: the print dialog opens. To skip it on a dedicated kitchen PC, start Chrome with `--kiosk-printing`.

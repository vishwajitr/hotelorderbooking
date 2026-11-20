# Setting up Hotel Orders for a new hotel

A checklist for installing Hotel Orders at one hotel, from creating its site to training staff.
Each hotel gets its own site and its own database. Allow about 15 minutes online beforehand and 1–2 hours at the hotel.

---

## 1. Collect from the hotel (before the visit)

- [ ] **Legal name, address and GSTIN.** Printed on every bill.
- [ ] **Menu**: dish, category, price, GST %, veg or non-veg. A spreadsheet is fine (see [Menu file](#menu-file)).
- [ ] **Staff names**: everyone who will take orders or bill. Each picks their own PIN on the day.
- [ ] **Thermal printer** model and paper width (80 mm or 58 mm).
- [ ] **Rooms**: whether they serve food to rooms and bill to the room at checkout.
- [ ] **Owner contact**: the person who will own the password and the Netlify account.

---

## 2. Create the hotel's site (online, about 15 minutes)

1. In Netlify, choose **Add new project → Import an existing project → GitHub**, and pick the `hotelorderbooking` repository.
   Name the site after the hotel, for example `grandpalace-orders`. Leave the build settings as they are (`netlify.toml` sets them).
2. **Site configuration → Environment variables → Add a variable**, each scoped to **Production** and marked secret:

   | Key | Value |
   |---|---|
   | `OWNER_PASSWORD` | A temporary starter password. The owner replaces it on day one. |
   | `SESSION_SECRET` | A long random string, e.g. the output of `openssl rand -hex 32` |
   | `HOTEL_TZ` | Only if the hotel is outside India (default `Asia/Kolkata`) |

3. **Deploys → Trigger deploy** twice. The first deploy creates the database; the second connects the app to it.
4. Check `https://<site>.netlify.app/api/me` shows `"configured":true`.
5. Optional: **Domain management → Add a domain** (e.g. `orders.hotelname.com`) and point the hotel's DNS at Netlify.

Write down the site address. Every device needs it.

---

## 3. Hardware at the hotel

| Item | Needed? | Notes |
|---|---|---|
| Counter PC (Windows or Mac) | Yes | Runs the desktop app, prints KOTs and bills without a dialog |
| Thermal printer (USB or LAN) | Yes | Install the manufacturer's driver first |
| Internet (Wi‑Fi or broadband) | Yes | The app does not work offline |
| Mobile hotspot | Recommended | Backup when the internet drops |
| Phones or tablets for waiters | Optional | Any modern browser, nothing to install |
| Kitchen screen (tablet or PC) | Optional | Shows the Live board |

---

## 4. On-site setup

### Counter PC
- [ ] Install the printer driver and print a **test page from the operating system** before anything else.
- [ ] Install Hotel Orders from the installer (`Hotel Orders Setup 1.0.0.exe` for Windows, the `.dmg` for Mac).
  The installer is not code-signed, so expect a warning: Windows **More info → Run anyway**, Mac **right-click → Open**.
- [ ] Menu **Hotel → Change site address…** and enter the hotel's site address.

### Owner account
- [ ] Log in with the starter password.
- [ ] **Settings → People & security → Owner password**: the owner types their own (8+ characters). The starter password stops working.

### Hotel details and menu
- [ ] **Settings → Hotel & bills**: hotel name, address, GSTIN, receipt paper width. **Save settings**.
- [ ] **Settings → Menu → Categories**: add the categories.
- [ ] Add dishes, or **Import menu** with the prepared file.
- [ ] Check GST rates. The app flags any dish whose rate differs from the rest.

### Staff
- [ ] **Settings → People & security → Staff**: add each person; each types their own 6–8 digit PIN.

### Printing
- [ ] On the counter PC only: **Settings → This device** → choose the thermal printer, turn on **Print KOTs automatically on this device**.
  Turn this on for **one device only**, or every KOT prints twice.

### Waiter phones and tablets
- [ ] Open the site address in the browser, **Add to Home Screen**, and log in with that person's PIN.

---

## 5. Test run (do all of these before the first real order)

- [ ] Place a table order from a phone. The KOT prints at the counter.
- [ ] **+ Items** on that order. A second KOT prints with only the new items.
- [ ] Move it **Start preparing → Mark served**, then **Bill** with a small discount. Check the preview, then **Bill & print**: CGST/SGST and total are correct and the hotel name, address and GSTIN print.
- [ ] Place a room order, bill it as **Charge to room**, then **Rooms → Checkout**. The room statement prints.
- [ ] **Reports → Day-end summary** shows the test bills.
- [ ] **Reports → Bill register → Void** every test bill (reason: "setup test") so real totals start clean.
  Bill numbers are never reused, so the first real bill will follow the test ones.
- [ ] **Settings → People & security → Download backup** and show the owner where the file went.

---

## 6. Training (about 30 minutes)

**Staff**
- New order: Table / Room / Takeaway, tap dishes, **Save & send KOT**.
- Live: move tickets along, **+ Items**, reprint **KOT**, **Cancel** (needs a reason).
- **Bill**: discount, payment (Cash / UPI / Card / Charge to room), **Bill & print**.
- Rooms: check-in a room bill, **Statement**, **Checkout**.

**Owner**
- Menu: add dishes, switch a dish off when it runs out, change prices, categories.
- Staff: add people, change a PIN, switch someone off when they leave (they are logged out at once).
- **Void** a wrong bill (Reports → Bill register).
- Day-end report and **Download CSV** for the accountant.
- **Log out all devices** if a phone is lost or a PIN leaks.
- **Download backup** every week.

---

## 7. Hand over to the hotel

- [ ] Owner has set their own password and knows it.
- [ ] Every staff member has logged in with their own PIN.
- [ ] Counter PC prints KOTs and bills.
- [ ] Owner has a backup file and knows how to make one.
- [ ] Owner has a support contact for internet, printer or app problems.
- [ ] If the hotel takes ownership: transfer the Netlify site to their account (**Site configuration → General → Transfer project**), give their developer access to the code, then change `SESSION_SECRET` and redeploy.

---

## Menu file

**Settings → Menu → Import menu** accepts a JSON list of dishes, or a backup file. Dishes already on the menu are skipped.

```json
[
  { "category": "Breakfast", "name": "Masala Dosa", "price": 90, "gst_pct": 5, "veg": 1 },
  { "category": "Main Course", "name": "Butter Chicken", "price": 320, "gst_pct": 5, "veg": 0 }
]
```

`veg`: 1 = veg, 0 = non-veg. `gst_pct` defaults to 5 if left out. A spreadsheet can be converted to this format.

---

## If something goes wrong

| Problem | Fix |
|---|---|
| "Cannot reach the hotel site" in the desktop app | Check the internet; **Hotel → Change site address…** if the address changed |
| KOTs don't print | Counter PC: app open, **This device** auto-print on, correct printer chosen, printer has paper |
| KOTs print twice | Auto-print is on for more than one device. Turn it off on all but one |
| Print dialog appears every time | That device is using a browser, not the desktop app. Use the app, or start Chrome with `--kiosk-printing` |
| "Too many wrong attempts" | Wait 15 minutes on that device |
| Owner forgot their password | In Netlify set `RESET_OWNER_PASSWORD=true`, redeploy, log in with `OWNER_PASSWORD`, set a new password, then remove `RESET_OWNER_PASSWORD` and redeploy |
| A phone is lost | **Settings → People & security → Log out all devices**, and switch off or change that person's PIN |
| "Database unavailable" | Usually passes in a minute. If not, check the site's Database page in Netlify |

## Known limits

- Needs internet. No offline mode.
- One hotel and one GSTIN per site; restaurant GST (CGST/SGST) only, no e-invoicing.
- No inventory, and no Zomato/Swiggy integration.
- Desktop updates are installed by hand on each PC.

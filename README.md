# VIN Tracker (night-shift PWA + Google Apps Script)

Phone app: type last 4–6 of a VIN → see the car, class, reservation countdown, status → tap **Picked Up / Shop / Charger / SP**.
Backend: `Code.gs` bound to your editable fleet Google Sheet (tab `Reservation Sort`). Every action is written to the status cell and to a `Log` tab.

Nothing secret lives in this folder. The API key lives only in the sheet's Script Properties and in the share link you generate.

## 2-minute setup (Mark)

1. **Open the editable sheet** (your owner copy, not the published link).
2. **Extensions → Apps Script.** Delete the default code, paste all of `Code.gs`, click **Save**.
3. Reload the sheet tab. A new menu **Fleet Tracker** appears (first run asks you to authorize: Advanced → Go to project → Allow).
4. **Fleet Tracker → Set API key** → enter a long random secret (12+ chars) → OK. *(Same as running `Setup` from the editor.)*
5. **Fleet Tracker → Set up** → updates the Status dropdowns to Picked Up / Shop / Charger / SP, rewrites the Status Summary, creates the `Log` tab.
6. In Apps Script: **Deploy → New deployment → ⚙ Web app** → *Execute as:* **Me** · *Who has access:* **Anyone** → **Deploy** → copy the **Web app URL** (ends in `/exec`).
   After any later edit to `Code.gs`: **Deploy → Manage deployments → ✎ → Version: New version → Deploy** (URL stays the same).
7. **Build the share link** on your computer:
   ```bash
   python3 -m venv .venv && .venv/bin/pip install qrcode pillow     # once
   .venv/bin/python tools/make_share_link.py \
       --app https://shoutinggoat0.github.io/vin-tracker/ \
       --url "PASTE_WEB_APP_URL"                                      # key is prompted (hidden)
   ```
   It prints `https://…/vin-tracker/#cfg=…` and saves `share-qr.png`. Text the link / show the QR to the crew.
8. Each phone: open the link → enter name → done (config saved on the phone; the hash is removed from the address bar). Then **Add to Home Screen** (iOS Safari: Share → Add to Home Screen; Android Chrome: ⋮ → Install app).

Treat the link/QR like a password. To rotate: **Fleet Tracker → Set API key**, rebuild the link, re-share.

### Test it
- Browser: `<Web app URL>?action=list&key=YOURKEY` should return JSON `{ok:true,vins:[…]}`.
- Phone: type 4 digits of a VIN, tap a button, check the sheet cell and the `Log` tab.

## Status Summary layout (written by *Fleet Tracker → Set up*)
Replaces the old Picked/Dropped block (same location, below the note). Columns by class, rows by status:

| Status Summary | Prod | CC | Dev | Total |
|---|---|---|---|---|
| Picked Up | `COUNTIF(C…,"Picked Up")` | `COUNTIF(E…)` | `COUNTIF(G…)` | sum |
| Shop | … | … | … | sum |
| Charger | … | … | … | sum |
| SP | … | … | … | sum |
| Blank (not updated) | VIN present, status empty | … | … | sum |
| Total VINs | `COUNTA(B…)` | `COUNTA(D…)` | `COUNTA(F…)` | sum |

Ranges run from row 4 to just above the footer note. If you add VIN rows, add them above the note (inside the range) and re-run **Set up** to refresh validation and formulas.
Old values like "Dropped Off" are left untouched but are no longer valid and aren't counted — change them to a new status.

## API
- `GET <exec>?action=list&key=KEY` → `{ok, generatedAt, vins:[{vin, klass:"Prod|CC|Dev", reservation:"Thu 10/01 4:00 AM", status}]}` (reservation time carried down from the group's first row).
- `POST <exec>` body (sent as `text/plain` JSON to avoid CORS preflight) `{key, name, digits, action, clientId}`:
  - exactly 1 VIN ends with `digits` (case-insensitive) → status cell set, row appended to `Log` (`Timestamp CT, Name, Digits, Full VIN, Class, Action, Reservation time, ClientId`) → `{ok:true, vin, klass, action, reservation}`
  - 0 or >1 matches → `{ok:false, error, matches:[…]}`, nothing written
  - duplicate `clientId`, or same VIN + action within 20 s → `{ok:true, duplicate:true}`, nothing written
  - Guarded by `LockService`; time zone America/Chicago; nothing beyond those fields is logged. Names starting with `= + - @` are prefixed with `'` so they can't become formulas.

## Hosting (GitHub Pages / Cloudflare Pages)
Static files only: `index.html app.js logic.js style.css manifest.webmanifest sw.js icons/` (+ `.nojekyll`). No build step, relative paths, works under a sub-path.
- GitHub Pages: push these to a repo, Settings → Pages → Deploy from branch `main` / root.
- Cloudflare Pages: connect the repo, build command empty, output directory `/`.
Do **not** commit the key, the `/exec` URL, or `share-qr.png`.

## Offline / PWA notes
- Service worker caches only the app shell (network-first, cache fallback) and never touches Apps Script requests.
- Taps while offline are queued in localStorage (one UUID each) and retried every 15 s / on reconnect; duplicates are harmless thanks to `clientId`.
- Countdowns parse `Thu 10/01 4:00 AM` as America/Chicago via `Intl` (DST-safe); the year is inferred from the weekday + nearest-to-now, so Dec→Jan rollover works.
- Digits keypad is numeric; tap **ABC** if a VIN's last characters include a letter (e.g. `…946` vs `X`).

## Dev
```bash
node test/logic.test.js     # digit matching, Chicago time parsing, countdown, cfg decode
node test/code.test.js      # Code.gs logic (loaded in a vm sandbox with mock IO)
python3 -m http.server 3020 # then open http://localhost:3020
python3 tools/make_icons.py # regenerate icons (needs Pillow)
```

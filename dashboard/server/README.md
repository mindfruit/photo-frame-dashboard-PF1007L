# Dashboard server

A small Node server for the family dashboard. It:

- keeps everything in SQLite (`server/data.db`, gitignored): people, chores, stars, rewards, shopping, countdowns, calendars and settings;
- serves a JSON API under `/api` and pushes live updates over Server-Sent Events (`/api/events`);
- fetches weather (Open-Meteo), Google calendars (secret iCal links) and Home Assistant states in the background;
- serves the built dashboard (`dist/`) and the parent page at `/admin`.

No Docker, no database server. Dependencies: `node-ical`, plus `better-sqlite3` only on Node < 22.5 (newer Node uses the built-in `node:sqlite`).

## Run (development, MacBook)

```sh
cd dashboard
npm install
npm run server      # API on http://localhost:3030
npm run dev         # Vite on :5173, proxies /api and /admin to :3030
# or both at once:
npm run dev:all
```

The frame keeps loading `http://<mac-ip>:5173/`; Vite forwards `/api` to the server.

## Parent page

Open `http://<mac-ip>:5173/admin` (dev) or `http://<server>:3030/admin` (production) on your phone.
The first visit asks you to create a parent PIN (4–8 digits). From there you can:

- approve chores the kids ticked (stars are added only once approved), adjust stars, redeem rewards;
- manage people, chores (who / when / which days / stars), rewards, countdowns, stores and usual groceries;
- add Google calendars (paste the "Secret address in iCal format"), weather location and units,
  Home Assistant URL + long-lived token, and change the PIN.

Saved calendar links and the HA token are never shown again in full. Calendar links can also go
in `server/.env` as `CAL_NAME=https://…`; they are imported once on startup (NAME matched to a person).

## What needs the PIN

Everything except what the frame itself does: a kid ticking/unticking a chore (it stays *pending*),
shopping list changes, and events added on the frame's calendar. The PIN is sent as the `X-PIN` header.
After 10 wrong PINs the server refuses for 10 minutes.

## API cheat sheet

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/state` | everything the dashboard renders |
| GET | `/api/events` | SSE stream; `change` events with a `topic` |
| GET/POST | `/api/auth`, `/api/auth/setup` | PIN status / check / first-time setup |
| GET | `/api/admin` | full admin data (PIN) |
| PUT | `/api/settings` | `location`, `units`, `ha_url`, `ha_token`, `clear_ha_token`, `new_pin` (PIN) |
| POST/PUT/DELETE | `/api/{people,chores,rewards,calendars,countdowns,routines,stores,usuals}[/id]` | CRUD (PIN) |
| POST/PUT/DELETE | `/api/{shopping,local-events}[/id]` | CRUD (no PIN) |
| POST/DELETE | `/api/chores/:id/complete` | kid marks done (pending) / undo |
| POST | `/api/completions/:id/approve`, `/reject`, `/api/completions/approve-all` | (PIN) |
| POST | `/api/stars`, `/api/redeem`, `/api/refresh`, `/api/ha/service` | (PIN) |

Example: `curl -H 'X-PIN: 1234' -H 'Content-Type: application/json' -d '{"name":"Maya","role":"kid"}' localhost:3030/api/people`

## Hosting / moving to another machine

Short version: production is `npm run build` then `node server/index.js` on **:3030** (no Vite,
no Docker). Copy `data.db` (checkpointed), `.env`, and the photos folder; use a LaunchAgent for
auto-start.

**Full guide (requirements, LaunchAgent, eero IP, frame re-pointing, Google OAuth localhost
callback, HA, backups, migrate script):**
[Hosting / moving to another machine](../../README.md#hosting--moving-to-another-machine) in the
repo root README.

```sh
cd dashboard
npm ci && npm rebuild better-sqlite3 && npm run build
PORT=3030 node server/index.js
```

Migrate helper: [`../scripts/migrate-host.sh`](../scripts/migrate-host.sh).
LaunchAgent template: [`../scripts/com.mindfruit.photoframe.plist.template`](../scripts/com.mindfruit.photoframe.plist.template).

## Files

- `index.js`: HTTP server, routes, PIN, SSE, static files
- `db.js`: schema and first-run defaults
- `state.js`: builds `/api/state` in the shapes the views expect
- `fetchers.js`: weather, iCal (recurring events via node-ical), Home Assistant
- `admin.html`: the parent page (plain HTML/JS)

## Home tab (Home Assistant)

Settings → HA URL + long-lived token, then **Home Assistant devices** → "Load devices". For each entity choose
Hidden / Control (tappable) / Sensor (read-only). The Home tab only appears when something is picked.
Taps go to `POST /api/ha/act`; the token never leaves the server. Locks, garage doors and alarms show a PIN pad.

## Per-person tabs and widgets

People → tick **Own tab** and pick widgets: chores, stars + week, rewards (kid can ask for one), countdowns,
today's calendar, weather, bedtime/wake, feelings check-in, star jar (goal reward), today in pictures
(emoji words are editable under *Picture words*), notes from parents (with optional photo, kid taps a heart),
learning corner (list in Settings, rotates daily) and the family scoreboard (weekly goal in Settings).

## Chore approval

Settings → **Chore approval** (off by default): off = ticking a chore adds stars right away; on = it waits in
*Waiting for approval*. People → **Chore approval** overrides it per person. Reward requests follow the same rule.

## Screens (devices) and profiles

Each screen that opens the dashboard checks in with an id: `?device=NAME` in its URL (recommended for frames,
e.g. `http://<server>/?device=frameo`), otherwise a random id saved in the browser. Parent page → **Screens**:
rename it, pick tabs + order, start tab, kid-lock (no menu rail; parents change it from their phone),
quiet hours and night brightness — or **Apply profile** (Family = everything, Kid = kid tabs only, locked,
quiet 7:30 PM–7 AM). New screens get Family. Changes reach the screen live.

## Photos, quiet hours, sounds, ok-to-wake

- Parent page → **Photos**: upload (resized on the phone, stored in `server/photos/`, gitignored). They replace
  the demo pictures; the photo date drives "on this day". Tag a person or mark as artwork.
- Settings → **Quiet from/until**: after 30 s idle in quiet hours the screen switches to the dim night clock.
  **Mute sounds** turns off the little WebAudio chimes (chores, rewards, check-ins).
- People → **Ok-to-wake HA light** + wake/bed colours: the server turns that light on in the colour at the
  person's wake time and bedtime.

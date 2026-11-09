# Board (split-flap tab, shown to people as “Flipboard”)

Internal names (API paths, `board_config`, tables, files) say *board*; everything people see says *Flipboard*.

A Vestaboard-style message board as a dashboard tab. The server decides what each screen shows; the frame
only draws the grid and flips the cells that changed.

| File | What it does |
|------|--------------|
| `charset.js` | Vestaboard codes (0–71), colour markup, word wrap and layout to the grid, palettes and contrast |
| `select.js` | The card selector (which card a screen shows now) |
| `sources.js` | Sources: each `fetch(ctx)` returns cards |
| `index.js` | Config, source refresh + last-good cache, per-screen compose, `/api/board` routes |
| `data/` | Bundled verses and quotes (see Licences) |
| `test.js` | `node server/board/test.js` (throwaway database, fake network) |
| `../../js/views/board.js`, `../../css/views/board.css` | The frame view |
| `../admin.html` | Admin › Flipboard, `#/flipboard` (search for “Flipboard (#/flipboard”); `#/settings/board` redirects there |

## Cards

Every source returns cards: `{ type, key, lines, starts_at?, expires_at?, stale_after?, dwell?, screens?, priority?, urgent? }`.
A newer card with the same key replaces the old one. Importance: **alert › personal › live = scheduled › ambient**.

| Type | Behaviour | From |
|------|-----------|------|
| alert | Preempts at once, short dwell (12 s), lasts 10 min or until the source stops emitting it | Home Assistant alert rules, sticky or urgent posts |
| personal | Biggest weight (5), halves every 3 h down to 20 %, gone after 12 h or when dismissed | Posted notes |
| live | Weight 2, hidden after `stale_after` | Weather, HA sensors, planes overhead |
| scheduled | Weight 2, only inside `starts_at..expires_at` | Next events, countdowns, static messages |
| ambient | Weight 1, shuffled, no repeat until the pool is used up; fills any gap | Bible verse, quotes |

A card that has never been shown and is higher than the one on screen replaces it at once. In quiet hours
(the screen’s own, else the global ones) only urgent alerts show. All of these defaults can be changed in
admin › Flipboard › Card types; each screen can turn card types off and change the weights.

## Text, colour and tiles

Letters A–Z, digits and `! @ # $ ( ) - + & = ; : ' " % , . / ? °`. Lower case is shown as upper case;
accents and curly quotes are folded.

* `{red}TEXT{/}`: letter colour (red orange yellow green blue violet white). A line end also ends it.
* `[green]`: a solid colour tile (red orange yellow green blue violet white black filled), or `{63}`–`{71}` by code.

A grid cell is `{ code }` or `{ code, fg }`. Posting unknown characters or colour names returns a 400 that says
what was wrong. Palettes: `standard` and `bright` per screen, with dim and warm-red night versions that follow
the screen’s night style. Every letter colour is at least 4.5:1 against its tile (`test.js` checks this).

## HTTP

```
GET    /api/board?screen=<device id>[&flip3d=0|1]   frame, no PIN
POST   /api/board/message   X-PIN: <pin>  or  Authorization: Bearer <board token>
       {"text":"{green}DINNER{/} AT 6:30","screen":"all","sticky":false,"urgent":false,"ttl_hours":12}
DELETE /api/board/message/<id>     DELETE /api/board/message[?screen=<id>]   (same auth)
GET    /api/board/admin   PUT /api/board/config   POST /api/board/copy {from,to}   POST /api/board/token   (PIN)
```

Example: `curl -X POST http://<server>:3030/api/board/message -H 'X-PIN: 1234' -H 'Content-Type: application/json' -d '{"text":"HELLO"}'`
(1234 is a placeholder; use your parent PIN or the token from admin › Flipboard).

The frame gets SSE `change {topic:'board'}` when its grid changes and then fetches its own grid. Config changes
are sent as `board-config`.

## Frame

Rows of inline-block cells (no CSS grid, no custom properties). Flip is a per-screen on/off setting: when it is on,
changed cells flip with CSS `rotateX` half-flaps, at most *Flips at once* (default 8) at a time. If the browser
can’t do 3D transforms (feature check, `-webkit-` included) the cells change instantly and the frame reports
`flip3d=0`, which the admin shows. If the server can’t be reached, the last grid stays up with a small dot.

## Sources that need setup

* **Planes overhead** (off by default): OpenSky anonymous (400 requests a day, so every 5 min; non-commercial)
  or adsb.lol (ODbL). No key. Uses the home location from Settings.
* **Tracked flight** (off, notes only, makes no requests): would need FlightAware AeroAPI (Personal tier) or
  AviationStack (free tier: 100 requests a month). Nobody has signed up for anything.
* Home Assistant sensors and alerts use the existing HA connection in Settings.

## Licences of bundled data

* `data/verses.json`: 236 short verses from the **World English Bible** (`eng-web.usfx.xml`,
  github.com/seven1m/open-bibles). The file’s own preface says: “the World English Bible is in the Public
  Domain (not copyrighted)”. 72 well-known verses plus short Proverbs, footnotes removed.
* `data/quotes.json`: 33 sayings from Benjamin Franklin’s **The Way to Wealth** (1758; Project Gutenberg
  eBook #43855, the 1810 Darton edition). Public domain.

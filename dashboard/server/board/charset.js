// Vestaboard character codes, colour markup and grid layout. Pure functions, no I/O.
// Codes: https://docs.vestaboard.com/docs/charactercodes (0 blank, 1-26 A-Z, 27-36 1-9 0, punctuation, 62 °,
// 63-70 colour tiles red orange yellow green blue violet white black, 71 filled).
//
// Markup inside any text (posts, static messages, sources):
//   {red}TEXT{/}   per-character foreground colour (names in FG below); {/} ends it, a line end ends it too
//   [red]          one solid colour tile (red orange yellow green blue violet white black filled)
//   {63}           a tile by its Vestaboard code (63-71)
// A cell in the grid is { code } or { code, fg } (fg only on letters, digits and punctuation).

const CHARS = { ' ': 0, '!': 37, '@': 38, '#': 39, $: 40, '(': 41, ')': 42, '-': 44, '+': 46, '&': 47, '=': 48, ';': 49, ':': 50, "'": 52, '"': 53, '%': 54, ',': 55, '.': 56, '/': 59, '?': 60, '°': 62 };
for (let i = 0; i < 26; i++) CHARS[String.fromCharCode(65 + i)] = i + 1;
for (let i = 1; i <= 9; i++) CHARS[String(i)] = 26 + i;
CHARS['0'] = 36;
export const CODE_CHARS = {}; // code -> glyph (the frame keeps its own copy in js/views/board.js)
for (const [ch, code] of Object.entries(CHARS)) CODE_CHARS[code] = ch;

export const TILES = { red: 63, orange: 64, yellow: 65, green: 66, blue: 67, violet: 68, white: 69, black: 70, filled: 71 };
export const FG = ['red', 'orange', 'yellow', 'green', 'blue', 'violet', 'white'];

// Typographic look-alikes folded into the board's character set before checking it.
const FOLD = { '‘': "'", '’': "'", '`': "'", '´': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', '\t': ' ', '\u00a0': ' ', 'º': '°', '×': 'X', '_': '-' };
function fold(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[‘’`´“”–—…\t\u00a0º×_]/g, (c) => FOLD[c]).toUpperCase();
}

// One line of text -> tokens [{code, fg?}] plus problems. strict: unknown characters / colour names are errors
// (POST validation); otherwise they are dropped (sources).
export function parseLine(text, strict = false) {
  const out = [], errors = [], bad = new Set();
  let fg = null;
  const s = String(text == null ? '' : text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']', j = s.indexOf(close, i + 1);
      const name = j > i ? s.slice(i + 1, j).trim().toLowerCase() : null;
      if (name != null && c === '{' && name === '/') { fg = null; i = j; continue; }
      if (name != null && c === '{' && FG.includes(name)) { fg = name; i = j; continue; }
      if (name != null && c === '{' && /^\d+$/.test(name) && +name >= 63 && +name <= 71) { out.push({ code: +name }); i = j; continue; }
      if (name != null && c === '[' && TILES[name]) { out.push({ code: TILES[name] }); i = j; continue; }
      if (name != null) {
        errors.push(c === '{' ? 'Unknown colour {' + name + '}. Text colours: ' + FG.join(', ') + ' (close with {/})'
          : 'Unknown tile [' + name + ']. Tiles: ' + Object.keys(TILES).join(', '));
        i = j; continue;
      }
      bad.add(c); continue;
    }
    const f = fold(c);
    for (const ch of f) {
      const code = CHARS[ch];
      if (code == null) { bad.add(c); continue; }
      out.push(code === 0 || !fg ? { code } : { code, fg });
    }
  }
  if (bad.size) errors.push('The board can’t show: ' + [...bad].map((x) => (x === '\n' ? '⏎' : x)).join(' ') + ' (letters, digits and ! @ # $ ( ) - + & = ; : \' " % , . / ? ° only)');
  return { tokens: out, errors: strict ? errors : [] };
}

// Lines (strings with markup) -> rows of tokens no wider than cols, word-wrapped; words longer than a row are split.
export function wrap(lines, cols, strict = false) {
  const rows = [], errors = [];
  for (const raw of [].concat(lines || [])) {
    for (const part of String(raw == null ? '' : raw).split('\n')) {
      const p = parseLine(part, strict);
      errors.push(...p.errors);
      const words = [];
      let w = [];
      for (const t of p.tokens) { if (t.code === 0) { if (w.length) words.push(w); w = []; } else w.push(t); }
      if (w.length) words.push(w);
      if (!words.length) { rows.push([]); continue; }
      let cur = null;
      for (let word of words) {
        while (word.length > cols) { if (cur) { rows.push(cur); cur = null; } rows.push(word.slice(0, cols)); word = word.slice(cols); }
        if (!word.length) continue;
        if (!cur) cur = word.slice();
        else if (cur.length + 1 + word.length <= cols) cur = cur.concat([{ code: 0 }], word);
        else { rows.push(cur); cur = word.slice(); }
      }
      if (cur) rows.push(cur);
    }
  }
  // drop leading/trailing empty rows (blank lines in the middle stay)
  while (rows.length && !rows[0].length) rows.shift();
  while (rows.length && !rows[rows.length - 1].length) rows.pop();
  return { rows, errors: [...new Set(errors)] };
}

// Lines -> a rows x cols grid of cells, centred (align 'center') or left-aligned, vertically centred.
export function layout(lines, cols = 22, rows = 6, align = 'center') {
  const w = wrap(lines, cols);
  const body = w.rows.slice(0, rows);
  const top = Math.floor((rows - body.length) / 2);
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const line = body[r - top] || [];
    const left = align === 'left' ? 0 : Math.floor((cols - line.length) / 2);
    const row = [];
    for (let c = 0; c < cols; c++) { const t = line[c - left]; row.push(t ? (t.fg ? { code: t.code, fg: t.fg } : { code: t.code }) : { code: 0 }); }
    grid.push(row);
  }
  return { grid, overflow: Math.max(0, w.rows.length - rows) };
}

// Validate posted text: returns { rows, errors } (errors = clear messages for the API).
export function check(text, cols = 22, rows = 6) {
  const t = String(text == null ? '' : text);
  if (!t.trim()) return { rows: 0, errors: ['Text is empty'] };
  if (t.length > 600) return { rows: 0, errors: ['Text is too long (' + t.length + ' characters, max 600 including colour markup)'] };
  const w = wrap([t], cols, true);
  const errors = w.errors.slice();
  if (w.rows.length > rows) errors.push('Too long: needs ' + w.rows.length + ' rows of ' + cols + ', the board has ' + rows);
  return { rows: w.rows.length, errors };
}

// Grid -> plain text (admin preview, tests). Tiles show as their first letter in lower case, filled as #.
const TILE_MARK = { 63: 'r', 64: 'o', 65: 'y', 66: 'g', 67: 'b', 68: 'v', 69: 'w', 70: 'k', 71: '■' };
export function gridText(grid) {
  return (grid || []).map((row) => row.map((c) => (c.code >= 63 ? TILE_MARK[c.code] : CODE_CHARS[c.code] || ' ')).join('')).join('\n');
}

// ------------------------------------------------------------------ palettes
// bg = the letter tile, text = default glyph colour, fg = per-character colours, tile = solid colour tiles.
// Every text and fg colour must read at >= 4.5:1 on bg (checked in test.js). Night ones match css/night.css.
export const PALETTES = {
  standard: { bg: '#1B1A18', text: '#EDE9E0', fg: { red: '#FF7A6E', orange: '#FFA552', yellow: '#F7D154', green: '#6CCB7E', blue: '#7DB8F2', violet: '#C0A3F5', white: '#FFFFFF' },
    tile: { 63: '#D7372A', 64: '#EE8A2A', 65: '#F2C230', 66: '#2E9E4F', 67: '#2563C9', 68: '#7448C0', 69: '#ECE9E2', 70: '#0E0E0D', 71: '#ECE9E2' } },
  bright: { bg: '#141414', text: '#FFFFFF', fg: { red: '#FF5C5C', orange: '#FF9F1C', yellow: '#FFE94D', green: '#3DEB7A', blue: '#4CC3FF', violet: '#D68CFF', white: '#FFFFFF' },
    tile: { 63: '#FF3B30', 64: '#FF9500', 65: '#FFD60A', 66: '#30D158', 67: '#0A84FF', 68: '#BF5AF2', 69: '#FFFFFF', 70: '#000000', 71: '#FFFFFF' } },
  // night dashboard (dim): muted, like css/night.css (--ink #C2A780 on #15110D)
  night: { bg: '#1C1712', text: '#C2A780', fg: { red: '#D98C7A', orange: '#D29A5E', yellow: '#CDB66A', green: '#8FB38F', blue: '#8FAAC4', violet: '#B39CC4', white: '#D6C8B0' },
    tile: { 63: '#6B2E22', 64: '#6E4A22', 65: '#6B5C2A', 66: '#2F4A33', 67: '#2E3D4B', 68: '#433650', 69: '#8A7A62', 70: '#0D0A07', 71: '#8A7A62' } },
  // night dashboard, warm red (bedrooms): no blue or green light, every colour becomes an amber/red tone
  'night-red': { bg: '#140A07', text: '#C0662E', fg: { red: '#D2553A', orange: '#C8742E', yellow: '#C98A3C', green: '#B8703A', blue: '#BC703F', violet: '#C26A44', white: '#CC7A44' },
    tile: { 63: '#5A1E10', 64: '#5A3010', 65: '#5E3A12', 66: '#3E2410', 67: '#36200F', 68: '#3E1F14', 69: '#6A3A1E', 70: '#0A0503', 71: '#6A3A1E' } }
};
export const ACCENTS = { red: '#E5483B', amber: '#F0A030', soft: '#9C8CD9', blue: '#4C8DF0', green: '#3FAE62' };

export function contrast(a, b) {
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); })
      .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  };
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

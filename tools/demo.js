// Made-up players and local stand-ins for every outbound request, shared by screenshots.js and test.js.
// Nothing leaves the machine. Names are placeholders; screenshots blur them anyway.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(ROOT, 'sotrep-live.user.js'), 'utf8');
const version = script.match(/@version\s+(\S+)/)[1];

const now = Date.now();
const ago = (min) => new Date(now - min * 60e3).toISOString();
const BASE = new Date(now - 3 * 864e5).toISOString();   // the baseline stamp from "three days ago"
const twitch = (u) => ({ platform: 'twitch', username: u, link: `https://www.twitch.tv/${u}` });

// [gamertag, minutes ago, presence, sotrep reply]
const recent = [
  ['Player One', 1, 'sot', { severe_count: 2, moderate_count: 1, manual_tags: ['Ship sinking'], account_count: 3, alts: [{}, {}] }],
  ['Player Two', 3, 'sot', { socials: [twitch('playertwo'), { platform: 'discord', username: 'playertwo' }], badges: ['Content creator'] }],
  ['Player Three', 6, 'on', { moderate_count: 2, light_count: 1 }],
  ['Player Four', 9, '', { light_count: 1, socials: [{ platform: 'steam', username: 'player4' }] }],
  ['Player Five', 12, 'sot', { badges: ['Verified'], pc_check_status: 'passed', socials: [{ platform: 'youtube', username: 'playerfive' }] }],
  ['Player Six', 15, 'on', {}],
];
const older = [
  ['Player Seven', 60 * 26, { moderate_count: 1 }],
  ['Player Eight', 60 * 27, {}],
  ['Player Nine', 60 * 28, { severe_count: 1 }],
  ['Player Ten', 60 * 50, {}],
];
const baseline = Array.from({ length: 30 }, (_, i) => `Old Crew ${i + 1}`);

const seen = {}, cache = {};
for (const [gt, m, , rep] of recent) { seen[gt] = ago(m); cache[gt] = { at: now, rep: { profile_id: 1, ...rep } }; }
for (const [gt, m, rep] of older) { seen[gt] = ago(m); cache[gt] = { at: now, rep: { profile_id: 1, ...rep } }; }
for (const gt of baseline) seen[gt] = BASE;

// players met more than once: earlier meetings, then the one that put them on the board
const meets = {
  'Player One': [ago(60 * 70), ago(60 * 30), ago(1)],
  'Player Three': [ago(60 * 5), ago(6)],
  'Player Four': [ago(60 * 26), ago(9)],
};

const store = () => ({
  seen: { ...seen }, cache: JSON.parse(JSON.stringify(cache)), meets: JSON.parse(JSON.stringify(meets)),
  baselined: true, baselineAt: BASE, me: { gt: 'Me', xuid: '1' }, lastVersion: version,
  inList: Object.fromEntries(Object.keys(seen).map(g => [g, true])), missing: {},
  alerts: { sound: true, discord: '', desktop: false, severe: true, moderate: true, streamers: true },
});
const list = [
  ...recent.map(([gt, , p]) => ({ Gamertag: gt, IsOnline: p !== '', IsPlayingSot: p === 'sot', DisplayPicUrl: '' })),
  ...[...older.map(o => o[0]), ...baseline].map(gt => ({ Gamertag: gt, IsOnline: false, IsPlayingSot: false, DisplayPicUrl: '' })),
];

// Tampermonkey stand-ins. Every request is logged in window.__calls and answered with demo data.
const gmStubs = (initial = store()) => `
  window.__store = ${JSON.stringify(initial)};
  window.__calls = [];
  window.GM_getValue = (k, d) => (k in __store ? JSON.parse(JSON.stringify(__store[k])) : d);
  window.GM_setValue = (k, v) => { __store[k] = JSON.parse(JSON.stringify(v)); };
  window.GM_notification = () => {};
  window.GM_info = { script: { version: '${version}' }, scriptUpdateURL: 'demo' };
  window.GM_xmlhttpRequest = (o) => { __calls.push(o.url); setTimeout(() => {
    let text = '{}';
    if (o.url.includes('meta.js')) text = '// @version ${version}';
    else if (o.url.includes('twitch.tv/playertwo')) text = '"isLiveBroadcast":true <meta property="og:description" content="Demo stream">';
    else if (o.url.includes('twitch.tv')) text = '';
    else if (o.url.includes('xbl-info')) text = JSON.stringify({ is_playing: true, presence_text: 'Sea of Thieves' });
    else if (o.url.includes('/api/search')) text = window.__searchBody || JSON.stringify({ error: 'not found' });
    o.onload && o.onload({ status: o.url.includes('/api/search') ? (window.__searchStatus || 200) : 200, responseText: text, responseHeaders: '' });
  }, 50); };
`;

// Opens the friends page with the script loaded. Returns a locator helper for things inside the shadow root.
async function open(page, initial, opts = {}) {
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.includes('/api/users/get-recent-friends')) {
      if (opts.recent) { const r = opts.recent(); if (r) return route.fulfill({ contentType: 'application/json', ...r }); }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(list) });
    }
    if (url.startsWith('https://www.seaofthieves.com/friends')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><script>var cfg={"r-gtg":"Me"}</script></head><body></body></html>' });
    return route.abort();
  });
  await page.addInitScript(gmStubs(initial));
  if (opts.initScript) await page.addInitScript(opts.initScript);
  await page.goto('https://www.seaofthieves.com/friends');
  await page.addScriptTag({ content: script });
  return (sel) => page.locator('#sotrep-live-host').locator(sel);
}

module.exports = { ROOT, script, version, store, list, open, now, ago };

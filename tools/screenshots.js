// Makes the README screenshots from made-up players. Nothing leaves the machine: every request the
// script would make (seaofthieves.com, sotrep.com, Twitch, GitHub) is answered locally with demo data.
// Names, socials and pictures are blurred so no placeholder can be mistaken for a real player.
// Run from the repo root: node tools/screenshots.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'images');
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

const store = {
  seen, cache, baselined: true, baselineAt: BASE, me: { gt: 'Me', xuid: '1' },
  inList: Object.fromEntries(Object.keys(seen).map(g => [g, true])), missing: {},
  alerts: { sound: true, discord: '', desktop: false, severe: true, moderate: true, streamers: true },
};
const list = [
  ...recent.map(([gt, , p]) => ({ Gamertag: gt, IsOnline: p !== '', IsPlayingSot: p === 'sot', DisplayPicUrl: '' })),
  ...[...older.map(o => o[0]), ...baseline].map(gt => ({ Gamertag: gt, IsOnline: false, IsPlayingSot: false, DisplayPicUrl: '' })),
];


const gmStubs = `
  window.__store = ${JSON.stringify(store)};
  window.GM_getValue = (k, d) => (k in __store ? JSON.parse(JSON.stringify(__store[k])) : d);
  window.GM_setValue = (k, v) => { __store[k] = v; };
  window.GM_notification = () => {};
  window.GM_info = { script: { version: '${version}' }, scriptUpdateURL: 'demo' };
  window.GM_xmlhttpRequest = (o) => setTimeout(() => {
    let text = '{}';
    if (o.url.includes('meta.js')) text = '// @version ${version}';
    else if (o.url.includes('twitch.tv/playertwo')) text = '"isLiveBroadcast":true <meta property="og:description" content="Demo stream">';
    else if (o.url.includes('twitch.tv')) text = '';
    else if (o.url.includes('xbl-info')) text = JSON.stringify({ is_playing: true, presence_text: 'Sea of Thieves' });
    else if (o.url.includes('/api/search')) text = JSON.stringify({ error: 'not found' });
    o.onload && o.onload({ status: 200, responseText: text, responseHeaders: '' });
  }, 50);
`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.includes('/api/users/get-recent-friends')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(list) });
    if (url.startsWith('https://www.seaofthieves.com/friends')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><script>var cfg={"r-gtg":"Me"}</script></head><body></body></html>' });
    return route.abort();
  });
  await page.addInitScript(gmStubs);
  await page.goto('https://www.seaofthieves.com/friends');
  await page.addScriptTag({ content: script });
  const shadow = (sel) => page.locator('#sotrep-live-host').locator(sel);

  await page.waitForTimeout(6000);   // first poll, the Twitch check and the Xbox presence pill
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.textContent = '.name,.soc,.pic{filter:blur(5px)}';
    document.getElementById('sotrep-live-host').shadowRoot.append(s);
  });
  const fit = async (sel = '.list', pad = -16) => ({ x: 0, y: 0, width: 1280, height: Math.min(760, Math.ceil(await shadow(sel).evaluate(e => e.getBoundingClientRect().bottom)) + pad) });
  await page.screenshot({ path: path.join(OUT, 'board.png'), clip: await fit() });

  await shadow('button[title="Alert settings"]').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'alerts.png'), clip: await fit('.panel', 0) });
  await shadow('button[title="Alert settings"]').click();

  await shadow('button.tab:has-text("History")').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'history.png'), clip: await fit() });

  await browser.close();
  console.log('Saved board.png, alerts.png and history.png in images/');
})();

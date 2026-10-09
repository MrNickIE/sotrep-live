// Checks the script in a real browser against made-up players. Every outbound request is answered locally.
// Run from the repo root: NODE_PATH=$(npm root -g) node tools/test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const demo = require('./demo');

let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' : ' + detail}`); if (!ok) failed++; };
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

async function fresh(browser, initial, scheme = 'dark', opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const q = await demo.open(page, initial, opts);
  await page.waitForTimeout(1500);
  return { ctx, page, q, errors };
}

(async () => {
  const browser = await chromium.launch();

  // ----- the board -----
  {
    const { ctx, page, q, errors } = await fresh(browser);
    await page.waitForTimeout(3000);
    eq('six players on Recent', await q('.list .row').count(), 6);
    eq('red rows', await q('.row.severe').count(), 1);
    eq('orange rows', await q('.row.moderate').count(), 1);
    eq('yellow rows', await q('.row.light').count(), 1);
    eq('green rows', await q('.row.clean').count(), 3);
    eq('version pill', (await q('.ver').textContent()).trim(), 'v' + demo.version);
    check('live streamer pill', await q('.row .tag.live').count() === 1, 'no LIVE pill');
    eq('no sign in buttons when signed in', await q('.status .signin').count(), 0);
    check('whats-new hidden when already seen', !(await q('.news').isVisible()), 'banner shown');

    // met again badges and the session card
    eq('met-again badges', await q('.tag.met:has-text("met ")').count() >= 3, true);
    check('badge text', (await q('.row:has-text("Player One") .tag.met').first().textContent()).includes('met 3 times'), 'wrong text');
    const recap = await q('.recap').textContent();
    check('session card shows six players', /6 players/.test(recap), recap);
    check('session card counts flags', /1 red/.test(recap) && /1 orange/.test(recap) && /3 clean/.test(recap), recap);

    check('session card: one live streamer, not every linked channel', /1 LIVE now/.test(recap) && /1 with a Twitch channel/.test(recap), recap);
    check('live is remembered for the card', await page.evaluate(() => !!__store.lives['Player Two']), 'not stored');

    // History, search, filters
    await q('button.tab:has-text("History")').click();
    const all = await q('.list .row').count();
    check('history lists players', all >= 10, 'rows ' + all);
    await q('.filters input[type=text]').fill('player th');
    eq('search by name', await q('.list .row').count(), 1);
    await q('.filters input[type=text]').fill('');
    await q('.filters button:has-text("Red")').click();
    check('red filter shows red only', (await q('.list .row').count()) >= 1 && (await q('.list .row:not(.severe)').count()) === 0, 'rows not all red');
    await q('.filters button:has-text("All")').click();
    await q('.filters .toggle:has-text("Streamers") input').evaluate(c => c.click());
    eq('streamers filter', await q('.list .row').count(), 1);
    await q('.filters .toggle:has-text("Streamers") input').evaluate(c => c.click());
    await q('.filters .toggle:has-text("Met more than once") input').evaluate(c => c.click());
    eq('met more than once filter', await q('.list .row').count(), 3);
    await q('.filters input[type=text]').fill('zzzz');
    check('no match message', /No one matches/.test(await q('.list').textContent()), 'no message');

    // theme and layout
    await q('button[title="Settings"]').click();
    await q('button.tab:has-text("Light")').click();
    check('light theme applied', await q('.root.light').count() === 1, 'no light class');
    await q('button.tab:has-text("Compact")').click();
    check('compact layout applied', await q('.root.compact').count() === 1, 'no compact class');
    const stored = await page.evaluate(() => __store.ui);
    eq('display choice stored', stored, { theme: 'light', layout: 'compact' });

    // closing settings
    await page.keyboard.press('Escape');   // earlier steps left the panel open
    await q('button[title="Settings"]').click();
    check('settings button says Close settings while open', /Close settings/.test(await q('button[title="Settings"]').textContent()), 'label');
    await q('.panel-head button:has-text("Close")').click();
    check('panel Close button closes settings', !(await q('.panel').isVisible()), 'still open');
    await q('button[title="Settings"]').click();
    await page.keyboard.press('Escape');
    check('Esc closes settings', !(await q('.panel').isVisible()), 'still open');
    await q('button[title="Settings"]').click();
    await q('button.tab:has-text("Recent")').click();
    check('switching tab closes settings', !(await q('.panel').isVisible()), 'still open');
    eq('button label restored', (await q('button[title="Settings"]').textContent()).trim(), 'Settings');

    // request budget: nothing but the expected hosts
    const calls = await page.evaluate(() => __calls);
    const odd = calls.filter(u => !/sotrep\.com\/api\/(player\/[^/]+\/xbl-info|search)|twitch\.tv\/|raw\.githubusercontent\.com/.test(u));
    eq('only expected outbound hosts', odd, []);
    check('no lookups for players already cached', !calls.some(u => u.includes('/api/search')), 'searched ' + calls.filter(u => u.includes('/api/search')).length);
    eq('no page errors', errors, []);
    await ctx.close();
  }

  // ----- match device theme -----
  {
    const { ctx, page, q } = await fresh(browser, { ...demo.store(), ui: { theme: 'auto', layout: 'comfortable' } }, 'light');
    check('match device follows a light device', await q('.root.light').count() === 1, 'not light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(200);
    check('and follows it back to dark', await q('.root.light').count() === 0, 'still light');
    await ctx.close();
  }

  // ----- backup: export, import, bad files -----
  {
    const withHook = { ...demo.store(), alerts: { sound: true, discord: 'https://discord.com/api/webhooks/1/secret', desktop: false, severe: true, moderate: true, streamers: true } };
    const a = await fresh(browser, withHook);
    await a.q('button[title="Settings"]').click();
    const [dl] = await Promise.all([a.page.waitForEvent('download'), a.q('button:has-text("Export backup")').click()]);
    check('backup file name', /^sotrep-live-backup-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()), dl.suggestedFilename());
    const file = path.join(os.tmpdir(), 'sotrep-live-test-backup.json');
    await dl.saveAs(file);
    const text = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(text);
    check('backup holds the players', Object.keys(data.seen).length === Object.keys(demo.store().seen).length, 'count');
    check('backup leaves out the Discord webhook', !text.includes('secret') && data.alerts.discord === '', 'webhook leaked');
    await a.ctx.close();

    // into an empty browser: everything comes back, webhook untouched
    const empty = { ...demo.store(), seen: {}, cache: {}, meets: {}, baselined: false, baselineAt: null, inList: null, lastVersion: demo.version, alerts: { ...demo.store().alerts, discord: 'https://discord.com/api/webhooks/2/mine' } };
    const b = await fresh(browser, empty);
    await b.q('button[title="Settings"]').click();
    await b.q('input[type=file]').setInputFiles(file);
    await b.page.waitForTimeout(500);
    check('import reports what it did', /Imported: \d+ new/.test(await b.q('.panel').textContent()), 'no message');
    const st = await b.page.evaluate(() => ({ seen: Object.keys(__store.seen).length, meets: Object.keys(__store.meets).length, hook: __store.alerts.discord, base: __store.baselined }));
    check('import restores players', st.seen >= Object.keys(demo.store().seen).length, JSON.stringify(st));
    check('import restores the meeting log', st.meets >= 3, JSON.stringify(st));
    eq('import keeps this browser\'s webhook', st.hook, 'https://discord.com/api/webhooks/2/mine');

    // bad files are refused and change nothing
    const before = await b.page.evaluate(() => JSON.stringify(__store.seen));
    const bad = path.join(os.tmpdir(), 'sotrep-live-test-bad.json');
    for (const [label, body] of [['not json', 'hello'], ['wrong format', '{"hello":1}']]) {
      fs.writeFileSync(bad, body);
      await b.q('input[type=file]').setInputFiles(bad);
      await b.page.waitForTimeout(300);
      check(`refuses a file that is ${label}`, /not a SOTREP Live backup/.test(await b.q('.panel').textContent()), 'accepted');
    }
    eq('refused files change nothing', await b.page.evaluate(() => JSON.stringify(__store.seen)), before);

    // a hostile file: prototype keys, script links and tracking pictures are dropped
    fs.writeFileSync(bad, JSON.stringify({
      format: 'sotrep-live-backup', version: 1,
      seen: { '__proto__': new Date().toISOString(), 'Evil One': new Date().toISOString(), 'Bad Date': 'nope' },
      cache: { 'Evil One': { at: Date.now(), rep: { gamerpic_url: 'http://tracker.example/x.png', profile_id: '../x?y', socials: [{ platform: 'twitch', username: 'x', link: 'javascript:alert(1)' }] } } },
    }));
    await b.q('input[type=file]').setInputFiles(bad);
    await b.page.waitForTimeout(300);
    const after = await b.page.evaluate(() => ({ polluted: ({}).polluted, hasEvil: 'Evil One' in __store.seen, badDate: 'Bad Date' in __store.seen, rep: __store.cache['Evil One'] && __store.cache['Evil One'].rep, protoOwn: Object.prototype.hasOwnProperty.call(__store.seen, '__proto__') }));
    check('hostile file: player added, junk dropped', after.hasEvil && !after.badDate && !after.protoOwn, JSON.stringify(after));
    check('hostile file: picture and profile id cleaned', after.rep && !('gamerpic_url' in after.rep) && !('profile_id' in after.rep), JSON.stringify(after.rep));
    eq('no page errors on import', b.errors, []);
    await b.ctx.close();
  }

  // ----- what's new -----
  {
    const older = { ...demo.store(), lastVersion: '1.0.2' };
    const { ctx, q } = await fresh(browser, older);
    check('whats-new shown after an update', await q('.news').isVisible(), 'hidden');
    check('whats-new names the version', (await q('.news').textContent()).includes(demo.version), 'wrong text');
    await q('.news button').click();
    check('whats-new goes away on Got it', !(await q('.news').isVisible()), 'still shown');
    await ctx.close();
    const first = { ...demo.store(), seen: {}, cache: {}, meets: {}, baselined: false, baselineAt: null, inList: null, lastVersion: null };
    const f = await fresh(browser, first);
    check('whats-new not shown on a fresh install', !(await f.q('.news').isVisible()), 'shown');
    eq('fresh install remembers the version', await f.page.evaluate(() => __store.lastVersion), demo.version);
    await f.ctx.close();
  }

  // ----- signed out of seaofthieves.com -----
  {
    let signedIn = false, recentCalls = 0;
    const { ctx, page, q, errors } = await fresh(browser, demo.store(), 'dark', {
      recent: () => { recentCalls++; return signedIn ? null : { status: 401, body: '{}' }; },
    });
    const btn = q('.status .signin');
    eq('one Sign in button', await btn.count(), 1);
    eq('button text', (await btn.textContent()).trim(), 'Sign in to seaofthieves.com');
    eq('button opens the login page in a new tab', [await btn.getAttribute('href'), await btn.getAttribute('target')], ['https://www.seaofthieves.com/login', '_blank']);
    check('status says not signed in', /Not signed in to seaofthieves\.com/.test(await q('.status').textContent()), await q('.status').textContent());
    eq('one request so far', recentCalls, 1);
    const focus = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await focus(); await focus(); await focus();
    await page.waitForTimeout(800);
    eq('refocusing retries once, not every time', recentCalls, 2);
    await page.waitForTimeout(21000);
    eq('no timer retries while signed out', recentCalls, 2);
    signedIn = true;
    await focus();
    await page.waitForTimeout(1200);
    eq('focus after signing in retries', recentCalls, 3);
    eq('button gone, no reload needed', await q('.status .signin').count(), 0);
    check('status back to normal', /in Recently Met/.test(await q('.status').textContent()), await q('.status').textContent());
    await page.waitForTimeout(21000);
    check('normal polling resumed', recentCalls >= 4, 'calls ' + recentCalls);
    eq('no page errors when signed out', errors.filter(e => !/status of 401/.test(e)), []);   // Chrome logs the 401 itself
    await ctx.close();
  }

  // ----- signed out of sotrep.com -----
  {
    const st = demo.store();
    delete st.cache['Player Five']; delete st.cache['Player Six'];
    const { ctx, page, q, errors } = await fresh(browser, st, 'dark', { initScript: 'window.__searchStatus = 401;' });
    const searches = () => page.evaluate(() => __calls.filter(u => u.includes('/api/search')).length);
    const btn = q('.status .signin');
    await page.waitForTimeout(1500);
    eq('one Sign in button for sotrep', await btn.count(), 1);
    eq('sotrep button text and link', [(await btn.textContent()).trim(), await btn.getAttribute('href'), await btn.getAttribute('target')], ['Sign in to sotrep.com', 'https://www.sotrep.com', '_blank']);
    eq('only one probe request, queue held', await searches(), 1);
    await page.waitForTimeout(21000);
    eq('no retries on a timer', await searches(), 1);
    check('status still names the button after a poll', await btn.count() === 1, 'button lost');
    await page.evaluate(() => { window.__searchStatus = 200; window.dispatchEvent(new Event('focus')); });
    await page.waitForTimeout(1500);
    eq('button gone once a lookup succeeds', await q('.status .signin').count(), 0);
    await page.waitForTimeout(3500);
    check('queue resumed', (await searches()) >= 3, 'searches ' + (await searches()));
    eq('no page errors when signed out of sotrep', errors, []);
    await ctx.close();
  }

  // ----- sotrep.com wants a captcha -----
  {
    const st = demo.store();
    delete st.cache['Player Five']; delete st.cache['Player Six'];
    const { ctx, page, q, errors } = await fresh(browser, st, 'dark', { initScript: "window.__searchStatus = 403; window.__searchBody = '{\"require_captcha\":true}';" });
    const searches = () => page.evaluate(() => __calls.filter(u => u.includes('/api/search')).length);
    const btn = q('.status .signin');
    await page.waitForTimeout(1500);
    eq('captcha: Open sotrep.com button', [(await btn.textContent()).trim(), await btn.getAttribute('href'), await btn.getAttribute('target')], ['Open sotrep.com', 'https://www.sotrep.com', '_blank']);
    check('captcha: status explains', /captcha/.test(await q('.status').textContent()), await q('.status').textContent());
    eq('captcha: one request, then paused', await searches(), 1);
    await page.evaluate(() => { window.__searchStatus = 200; window.__searchBody = ''; window.dispatchEvent(new Event('focus')); });
    await page.waitForTimeout(500);
    eq('captcha: button goes on return', await q('.status .signin').count(), 0);
    await page.waitForTimeout(17000);
    check('captcha: lookups resume after return', (await searches()) >= 2, 'searches ' + (await searches()));
    eq('no page errors on captcha', errors.filter(e => !/status of 403/.test(e)), []);
    await ctx.close();
  }

  await browser.close();
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
})();

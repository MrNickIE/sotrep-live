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
    check('session card names who to watch out for', (await q('.recap .hl.bad').textContent()).includes('Player One'), 'no watch out card');
    check('session card names the live streamer', (await q('.recap .hl.tw').textContent()).includes('Player Two'), 'no live card');
    eq('reputation badges carry a shape', await q('.list .row .rep svg').count(), 6);
    eq('tab counts', [(await q('.nav .tab:has-text("Recent") .count').textContent()), (await q('.nav .tab:has-text("History") .count').textContent())], ['6', '40']);
    eq('logo links to the project page', [await q('.brand a.home').getAttribute('href'), await q('.brand a.home').getAttribute('target')], ['https://github.com/MrNickIE/sotrep-live', '_blank']);
    eq('Settings has the project page and issues links', await q('#set-about a').evaluateAll(as => as.map(a => a.getAttribute('href'))), ['https://github.com/MrNickIE/sotrep-live', 'https://github.com/MrNickIE/sotrep-live/issues']);
    eq('no Clear or Reset in the top bar', await q('.bar button:has-text("Clear"), .bar button:has-text("Reset")').count(), 0);
    check('session card counts flags', /1 red/.test(recap) && /1 orange/.test(recap) && /3 clean/.test(recap), recap);

    check('session card: one live streamer, not every linked channel', /1 LIVE now/.test(recap) && /1 with a Twitch channel/.test(recap), recap);
    check('live is remembered for the card', await page.evaluate(() => !!__store.lives['Player Two']), 'not stored');

    // History, search, filters
    await q('button.tab:has-text("History")').click();
    const all = await q('.list .row').count();
    check('history lists players', all >= 10, 'rows ' + all);
    eq('colour filters show counts', [await q('.filters button:has-text("Red") .n').textContent(), await q('.filters button:has-text("Not checked") .n').textContent()], ['2', '30']);
    check('history is a table with a header', await q('.list .table .hhead').count() === 1, 'no table header');
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
    eq('display choice stored', stored, { theme: 'light', layout: 'compact', pinRed: true });

    // closing settings
    await page.keyboard.press('Escape');   // earlier steps left the panel open
    await q('button[title="Settings"]').click();
    eq('gear button shows pressed while settings is open', await q('button[title="Settings"]').getAttribute('aria-pressed'), 'true');
    check('settings takes the place of the board', !(await q('.list').isVisible()), 'board still shown');
    await q('.panel-head button:has-text("Close")').click();
    check('panel Close button closes settings', !(await q('.panel').isVisible()), 'still open');
    await q('button[title="Settings"]').click();
    await page.keyboard.press('Escape');
    check('Esc closes settings', !(await q('.panel').isVisible()), 'still open');
    await q('button[title="Settings"]').click();
    await q('button.tab:has-text("Recent")').click();
    check('switching tab closes settings', !(await q('.panel').isVisible()), 'still open');
    eq('gear button released', await q('button[title="Settings"]').getAttribute('aria-pressed'), 'false');
    check('board back after settings closes', await q('.list').isVisible(), 'board hidden');

    // Twitch hiccups: an error or a non-200 keeps LIVE, one clean "offline" keeps it, a second clears it to "was live"
    await page.evaluate(() => {
      const real = window.GM_xmlhttpRequest;
      window.__skew = 0; window.__tw = '';
      const now = Date.now.bind(Date); Date.now = () => now() + window.__skew;
      window.GM_xmlhttpRequest = (o) => {
        if (!o.url.includes('twitch.tv/playertwo') || !window.__tw) return real(o);
        window.__calls.push(o.url);
        setTimeout(() => o.onload({ status: window.__tw === 'err' ? 503 : 200, responseText: window.__tw === 'off' ? '<html></html>' : '', responseHeaders: '' }), 20);
      };
    });
    const cycle = async (mode) => { await page.evaluate((m) => { window.__tw = m; window.__skew += 6 * 60e3; }, mode); await page.waitForTimeout(24000); };
    await cycle('err');
    eq('Twitch 503 keeps LIVE', await q('.row .tag.live').count(), 1);
    await cycle('off');
    eq('one offline answer keeps LIVE', await q('.row .tag.live').count(), 1);
    await cycle('off');
    eq('second offline answer clears LIVE', await q('.row .tag.live').count(), 0);
    check('was live tag links to channel', /^was live \d\d:\d\d$/.test((await q('.row .tag.wasLive').first().textContent()).trim()) && (await q('.row .tag.wasLive').first().getAttribute('href')).includes('twitch.tv/playertwo'), 'tag missing');

    // request budget: nothing but the expected hosts
    const calls = await page.evaluate(() => __calls);
    const odd = calls.filter(u => !/sotrep\.com\/api\/(player\/[^/]+\/xbl-info|search)|twitch\.tv\/|raw\.githubusercontent\.com/.test(u));
    eq('only expected outbound hosts', odd, []);
    check('no lookups for players already cached', !calls.some(u => u.includes('/api/search')), 'searched ' + calls.filter(u => u.includes('/api/search')).length);
    eq('no page errors', errors, []);
    await ctx.close();
  }

  // ----- Clear and Reset live in Settings -----
  {
    const { ctx, page, q, errors } = await fresh(browser);
    await q('button[title="Settings"]').click();
    await q('.panel button:has-text("Reset everything")').click();
    eq('Reset arms on the first press', (await q('.panel .btn.armed').textContent()).trim(), 'Press again to reset');
    check('an armed Reset forgets nothing yet', await page.evaluate(() => Object.keys(__store.seen).length) === 40, 'store changed');
    await q('.panel button:has-text("Clear board")').click();
    await q('.panel-head button:has-text("Close")').click();
    eq('Clear board empties Recent', await q('.list .row').count(), 0);
    check('Clear board keeps everyone remembered', await page.evaluate(() => Object.keys(__store.seen).length) === 40, 'store changed');
    eq('no page errors on Clear', errors, []);
    await ctx.close();
  }

  // ----- several streamers live at once -----
  {
    const st = demo.store();
    for (const gt of ['Player Three', 'Player Five', 'Player Six']) st.cache[gt].rep.socials = [{ platform: 'twitch', username: gt.replace(' ', '').toLowerCase(), link: `https://www.twitch.tv/${gt.replace(' ', '').toLowerCase()}` }];
    const init = `const real = window.GM_xmlhttpRequest; window.GM_xmlhttpRequest = (o) => {
      if (!o.url.includes('twitch.tv')) return real(o);
      window.__calls.push(o.url); setTimeout(() => o.onload({ status: 200, responseText: '"isLiveBroadcast":true', responseHeaders: '' }), 20); };`;
    const { ctx, page, q, errors } = await fresh(browser, st, 'dark', { initScript: init });
    await page.waitForTimeout(9000);   // four Twitch checks, 2 s apart
    const card = await q('.recap .hl.tw').textContent();
    check('live card counts every live streamer', /Live on Twitch \(4\)/.test(card), card);
    eq('live card names three, then the rest as more', [await q('.recap .hl.tw .name').count(), (await q('.recap .hl.tw .more').textContent()).trim()], [3, '+1 more']);
    check('each live name links to its stream', (await q('.recap .hl.tw .name').first().getAttribute('href')).includes('twitch.tv/'), 'no link');
    eq('one live card, not one per streamer', await q('.recap .hl.tw').count(), 1);
    eq('no page errors with several live', errors, []);
    await ctx.close();
  }

  // ----- reacting on sotrep.com from the board -----
  {
    const st = demo.store();
    st.cache['Player One'].rep.xuid = 111; st.cache['Player Three'].rep.xuid = 333;
    st.cache['Player Nine'].rep.xuid = 999;   // in History only
    const init = `window.__toggle = 200; window.__toggleBody = '{}'; window.__reviews = 200; window.__mine = ['clown']; window.__rx = [];
      const real = window.GM_xmlhttpRequest; window.GM_xmlhttpRequest = (o) => {
        if (/\\/reviews\\?|\\/reactions\\//.test(o.url)) {
          window.__rx.push({ m: o.method, u: o.url, t: Date.now() });
          const toggle = o.url.includes('/toggle');
          const body = toggle ? window.__toggleBody : JSON.stringify({ reactions: { skilled: 2, clown: 1 }, my_reactions: window.__mine });
          setTimeout(() => o.onload({ status: toggle ? window.__toggle : window.__reviews, responseText: body, responseHeaders: '' }), 20);
          return;
        }
        return real(o);
      };`;
    const { ctx, page, q, errors } = await fresh(browser, st, 'dark', { initScript: init });
    await page.waitForTimeout(1500);
    const rx = () => page.evaluate(() => __rx);
    const posts = async () => (await rx()).filter(c => c.m === 'POST');
    eq('React only on players with an Xbox ID on Recent', await q('.list .react-btn').count(), 2);
    eq('nothing loaded until you open it', await rx(), []);
    const one = q('.row:has-text("Player One")'), three = q('.row:has-text("Player Three")');
    await one.locator('.react-btn').click();
    await page.waitForTimeout(300);
    eq('opening loads the counts', (await rx()).length, 1);
    eq('four reactions with sotrep counts', await one.locator('.rchip').allTextContents(), ['Suspicious0', 'Skilled2', 'Clown1', 'Friendly0']);
    eq('your own reaction shows as on', await one.locator('.rchip.on').allTextContents(), ['Clown1']);
    await one.locator('.rchip:has-text("Skilled")').click();
    await page.waitForTimeout(1900);
    eq('one click sends one toggle', (await posts()).map(c => c.u), ['https://www.sotrep.com/api/player/111/reactions/skilled/toggle']);
    eq('the count and state follow', await one.locator('.rchip.on').allTextContents(), ['Skilled3', 'Clown1']);

    // reopening reads again, so a reaction left on sotrep.com in the meantime is seen
    await page.evaluate(() => { window.__mine = ['clown', 'cheater']; });
    await one.locator('.react-btn').click();
    await one.locator('.react-btn').click();
    await page.waitForTimeout(1900);
    eq('reopening reads your reactions again', (await rx()).filter(c => c.m === 'GET').length, 2);
    eq('and shows what you did on sotrep.com', await one.locator('.rchip.on').allTextContents(), ['Suspicious0', 'Clown1']);

    // clicks on two cards at once still go one at a time
    await three.locator('.react-btn').click();
    await page.waitForTimeout(1900);
    await one.locator('.rchip:has-text("Friendly")').click();
    await three.locator('.rchip:has-text("Skilled")').click();
    await page.waitForTimeout(3600);
    const ps = await posts();
    eq('both cards sent their toggle', ps.length, 3);
    check('clicks on different cards are spaced out', ps[2].t - ps[1].t >= 1400, `${ps[2].t - ps[1].t} ms apart`);
    const all = await rx();
    check('every reaction request is spaced out, reads too', all.every((c, i) => !i || c.t - all[i - 1].t >= 1400), JSON.stringify(all.map(c => c.t)));

    // a failed read shows no buttons, only Reload, so a click can never toggle blind
    await page.evaluate(() => { window.__reviews = 500; });
    await three.locator('.react-btn').click();
    await three.locator('.react-btn').click();
    await page.waitForTimeout(1900);
    eq('failed read: no reaction buttons', await three.locator('.rchip').count(), 0);
    check('failed read: says so and offers Reload', /Could not load reactions/.test(await three.locator('.react').textContent()) && await three.locator('.react button:has-text("Reload")').count() === 1, await three.locator('.react').textContent());
    // a reply that does not list your reactions is not enough to show buttons
    await page.evaluate(() => { window.__reviews = 200; window.__mine = null; });
    await three.locator('.react button:has-text("Reload")').click();
    await page.waitForTimeout(1900);
    eq('reply without your reactions: still no buttons', await three.locator('.rchip').count(), 0);
    await page.evaluate(() => { window.__mine = ['clown', 'cheater']; });
    await three.locator('.react button:has-text("Reload")').click();
    await page.waitForTimeout(1900);
    eq('Reload brings the buttons back', await three.locator('.rchip').count(), 4);

    // a known refusal keeps the buttons; a slow-down pauses everything, reads included
    await page.evaluate(() => { window.__toggleBody = '{"error":"reaction_cooldown","reaction_type":"skilled"}'; });
    await one.locator('.rchip:has-text("Skilled")').click();
    await page.waitForTimeout(1900);
    check('a refusal is shown and nothing changes', /Wait a second before selecting Skilled/.test(await one.locator('.react').textContent()) && (await one.locator('.rchip').count()) === 4, await one.locator('.react').textContent());
    await page.evaluate(() => { window.__toggle = 429; window.__toggleBody = '{}'; });
    await one.locator('.rchip:has-text("Clown")').click();
    await page.waitForTimeout(1900);
    check('a slow-down pauses reacting', /slow down/.test(await one.locator('.react').textContent()), await one.locator('.react').textContent());
    let before = (await rx()).length;
    await three.locator('.react-btn').click();
    await three.locator('.react-btn').click();
    await page.waitForTimeout(1900);
    eq('no read is sent while paused', (await rx()).length, before);
    check('the panel says why', /asked us to wait/.test(await three.locator('.react').textContent()), await three.locator('.react').textContent());

    // signed out of sotrep: the usual button, then nothing is sent
    await page.evaluate(() => { window.__skew = 0; const now = Date.now.bind(Date); Date.now = () => now() + 16 * 60e3; window.__toggle = 401; });
    await one.locator('.react-btn').click();
    await one.locator('.react-btn').click();
    await page.waitForTimeout(1900);
    await one.locator('.rchip:has-text("Friendly")').click();
    await page.waitForTimeout(1900);
    eq('signed out of sotrep: the usual Sign in button appears', (await q('.status .signin').textContent()).trim(), 'Sign in to sotrep.com');
    eq('signed out: buttons give way to Reload', await one.locator('.rchip').count(), 0);
    before = (await rx()).length;
    await one.locator('.react button:has-text("Reload")').click();
    await page.waitForTimeout(1900);
    eq('no more reactions sent while signed out', (await rx()).length, before);
    await q('button.tab:has-text("History")').click();
    eq('no React in History', await q('.list .react-btn').count(), 0);
    eq('no page errors when reacting', errors, []);
    await ctx.close();
  }

  // ----- no React for a name typed by hand -----
  {
    const init = `window.__searchBody = JSON.stringify({ gamertag: 'Typed Name', xuid: 555, profile_id: 1 });`;
    const { ctx, page, q } = await fresh(browser, demo.store(), 'dark', { initScript: init });
    await q('.controls input').fill('Typed Name');
    await q('.controls button:has-text("Check")').click();
    await page.waitForTimeout(1500);
    eq('typed name is looked up and shown', await q('.row:has-text("Typed Name") .rep').count(), 1);
    eq('but has no React button', await q('.row:has-text("Typed Name") .react-btn').count(), 0);
    await ctx.close();
  }

  // ----- a player with dozens of socials -----
  {
    const st = demo.store();
    st.cache['Player Six'].rep.socials = [
      ...Array.from({ length: 12 }, () => ({ platform: 'steam', username: 'steam' })),
      ...Array.from({ length: 8 }, (_, i) => ({ platform: 'steam', username: 'alt' + i })),
      { platform: 'twitch', username: 'sixtv', link: 'https://www.twitch.tv/sixtv' },
      { platform: 'steam', username: 'secretalt', hidden: true },
    ];
    st.cache['Player Five'].rep.socials = [{ platform: 'steam', username: 'steam' }, { platform: 'steam', username: 'steam', link: 'https://steamcommunity.com/id/a' }, { platform: 'steam', username: 'steam', link: 'https://steamcommunity.com/id/b' }, { platform: 'steam', username: 'steam', link: 'https://steamcommunity.com/id/b/' }];
    const { ctx, page, q, errors } = await fresh(browser, st);
    const six = q('.row:has-text("Player Six")');
    eq('different accounts with the same name both kept, with their links', await q('.row:has-text("Player Five") a.soc').evaluateAll(as => as.map(a => a.getAttribute('href'))), ['https://steamcommunity.com/id/a', 'https://steamcommunity.com/id/b']);
    eq('a bare copy gives way to a linked one', await q('.row:has-text("Player Five") .soc').count(), 2);
    eq('socials capped on a card', await six.locator('.soc:not(.more)').count(), 4);
    eq('repeats merged, the rest behind more', (await six.locator('.soc.more').textContent()).trim(), '+6 more');
    check('Twitch comes first', (await six.locator('.soc').first().textContent()).includes('sixtv'), await six.locator('.soc').first().textContent());
    await six.locator('.soc.more').click();
    eq('more opens them all', await six.locator('.soc:not(.more)').count(), 10);
    eq('and offers to fold them back', (await six.locator('.soc.more').textContent()).trim(), 'Show fewer');
    await six.locator('.soc.more').click();
    eq('Show fewer folds them', await six.locator('.soc:not(.more)').count(), 4);
    await q('button.tab:has-text("History")').click();
    eq('History shows three', await q('.row:has-text("Player Six") .soc:not(.more)').count(), 3);
    await q('.filters input[type=text]').fill('secretalt');
    eq('a hidden social cannot be found by searching', await q('.list .row').count(), 0);
    await q('.filters input[type=text]').fill('alt7');
    check('a History search shows the social it matched', (await q('.row:has-text("Player Six") .soc:not(.more)').allTextContents()).some(t => t.includes('alt7')), 'alt7 hidden');
    await q('.filters input[type=text]').fill('');
    eq('no page errors with many socials', errors, []);
    await ctx.close();
  }

  // ----- red players pinned to the top -----
  {
    const st = demo.store();
    st.cache['Player Six'].rep = { profile_id: 1, severe_count: 1 };   // the oldest player on the board
    const { ctx, page, q, errors } = await fresh(browser, st);
    const names = async () => (await q('.list .row .name').allTextContents());
    eq('red players first, newest first', (await names()).slice(0, 2), ['Player One', 'Player Six']);
    check('under a Watch out heading', /Watch out\s*2/.test(await q('.list .section').first().textContent()), await q('.list .section').first().textContent());
    await q('button[title="Settings"]').click();
    await q('.sw[aria-label="Pin red players to the top of Recent"]').evaluate(c => c.click());
    await q('.panel-head button:has-text("Close")').click();
    eq('switched off: plain newest first', (await names()).slice(-1), ['Player Six']);
    eq('the choice is kept', await page.evaluate(() => __store.ui.pinRed), false);
    eq('no page errors with pinning', errors, []);
    await ctx.close();
  }

  // ----- sessions follow your Xbox status -----
  {
    const t = (m) => new Date(Date.now() - m * 60e3).toISOString();
    const six = ['Player One', 'Player Two', 'Player Three', 'Player Four', 'Player Five', 'Player Six'];
    const withTimes = (mins, play) => { const st = demo.store(); st.meets = {}; six.forEach((gt, i) => { st.seen[gt] = t(mins[i]); }); st.play = play; return st; };
    // the board saw this sitting begin 20 minutes ago: meetings before it belong to the last one, even under 90 minutes apart
    const a = await fresh(browser, withTimes([5, 15, 60, 100, 130, 400], { start: t(20), last: t(2), seenStart: true }));
    eq('a sitting the board saw begin keeps only its own players', await a.q('.list .row').count(), 2);
    const ra = await a.q('.recap').textContent();
    check('session card counts that sitting and says when it began', /2 players/.test(ra) && /Playing since/.test(ra), ra);
    await a.ctx.close();
    // with the tab hidden, the first playing check can come 15 minutes into a sitting: players met before it still count
    const a2 = await fresh(browser, withTimes([5, 25, 40, 300, 400, 500], { start: t(20), last: t(2), seenStart: true, from: t(35) }));
    eq('players met before the first playing check still count', await a2.q('.list .row').count(), 2);
    await a2.ctx.close();
    // a long quiet spell with no meetings does not split a sitting
    const b = await fresh(browser, withTimes([5, 180, 300, 400, 500, 600], { start: t(200), last: t(1), seenStart: true }));
    eq('a quiet spell over 90 minutes stays one session while you play', await b.q('.list .row').count(), 2);
    await b.ctx.close();
    // the page opened mid-game: the earlier meetings still count
    const c = await fresh(browser, withTimes([5, 40, 70, 300, 400, 500], { start: t(10), last: t(1), seenStart: false }));
    eq('opened mid-game: meetings before the first check still count', await c.q('.list .row').count(), 3);
    await c.ctx.close();
    // the board watches you go from not playing to playing
    const init = `window.__skew = 0; const now = Date.now.bind(Date); Date.now = () => now() + window.__skew;
      window.__xbl = { is_playing: false, presence_text: 'Last seen 5m ago: Xbox App' };
      const real = window.GM_xmlhttpRequest; window.GM_xmlhttpRequest = (o) => {
        if (!o.url.includes('xbl-info')) return real(o);
        window.__calls.push(o.url);
        setTimeout(() => o.onload({ status: 200, responseText: JSON.stringify(window.__xbl), responseHeaders: '' }), 20);
      };`;
    // fresh times: met 2, 4, 8 and 12 minutes ago, and one of them also met yesterday
    const dst = withTimes([2, 4, 8, 12, 300, 400], null);
    dst.meets = { 'Player One': [t(60 * 26), t(2)] };
    const d = await fresh(browser, dst, 'dark', { initScript: init });
    await d.page.waitForTimeout(4500);
    eq('not playing: no sitting yet', await d.page.evaluate(() => __store.play), null);
    await d.page.evaluate(() => { window.__xbl = { is_playing: true, presence_text: 'Sea of Thieves' }; window.__skew += 6 * 60e3; document.dispatchEvent(new Event('visibilitychange')); });
    await d.page.waitForTimeout(800);
    eq('then playing: a sitting starts, and the board saw it begin', await d.page.evaluate(() => __store.play && __store.play.seenStart), true);
    eq('Xbox was late: players met up to 10 minutes before the last off reading stay on the board', await d.q('.list .row .name').allTextContents(), ['Player One', 'Player Two', 'Player Three']);
    check('a player met again on another day does not drag the start back', !/\d+ h \d+ min/.test(await d.q('.recap').textContent()), await d.q('.recap').textContent());
    check('session card says playing since', /Playing since/.test(await d.q('.recap').textContent()), await d.q('.recap').textContent());
    const step = (xbl, mins) => d.page.evaluate(([x, m]) => { window.__xbl = x; window.__skew += m * 60e3; document.dispatchEvent(new Event('visibilitychange')); }, [xbl, mins]);
    const off = { is_playing: false, presence_text: 'Last seen 1m ago: Home' }, on = { is_playing: true, presence_text: 'Sea of Thieves' };
    const start1 = await d.page.evaluate(() => __store.play.start);
    await step(off, 15); await d.page.waitForTimeout(500);
    await step(on, 15); await d.page.waitForTimeout(500);
    eq('one odd reading mid-game does not split the sitting', await d.page.evaluate(() => __store.play.start), start1);
    // a crash and relaunch with the board visible: two off readings 5 minutes apart do not end the sitting
    await step(off, 5); await d.page.waitForTimeout(500);
    await step(off, 5); await d.page.waitForTimeout(500);
    await step(on, 5); await d.page.waitForTimeout(500);
    eq('a short break (crash and relaunch) keeps the sitting', await d.page.evaluate(() => __store.play.start), start1);
    // a real break: not playing for 15 minutes
    for (let i = 0; i < 4; i++) { await step(off, 5); await d.page.waitForTimeout(400); }
    await step(on, 5); await d.page.waitForTimeout(800);
    check('15 minutes of not playing ends it: the next playing reading starts a new sitting', await d.page.evaluate((s1) => __store.play.start !== s1 && __store.play.seenStart === true, start1), JSON.stringify(await d.page.evaluate(() => __store.play)));
    eq('with the tab open, the board starts afresh for the new sitting', await d.q('.list .row').count(), 0);
    check('and the card shows the new sitting straight away', /No one met yet/.test(await d.q('.recap').textContent()) && /Playing since/.test(await d.q('.recap').textContent()), await d.q('.recap').textContent());
    eq('no page errors with Xbox sessions', d.errors, []);
    await d.ctx.close();
  }

  // ----- sotrep.com wants a captcha while you react -----
  {
    const st = demo.store();
    st.cache['Player One'].rep.xuid = 111;
    const init = `window.__toggle = 403; window.__rx = 0;
      const real = window.GM_xmlhttpRequest; window.GM_xmlhttpRequest = (o) => {
        if (/\\/reviews\\?|\\/reactions\\//.test(o.url)) {
          window.__rx++;
          const toggle = o.url.includes('/toggle');
          setTimeout(() => o.onload({ status: toggle ? window.__toggle : 200, responseText: toggle ? '{"require_captcha":true}' : JSON.stringify({ reactions: {}, my_reactions: [] }), responseHeaders: '' }), 20);
          return;
        }
        return real(o);
      };`;
    const { ctx, page, q, errors } = await fresh(browser, st, 'dark', { initScript: init });
    const one = q('.row:has-text("Player One")');
    await one.locator('.react-btn').click();
    await page.waitForTimeout(400);
    await one.locator('.rchip:has-text("Skilled")').click();
    await page.waitForTimeout(1900);
    eq('captcha: the status line offers Open sotrep.com', (await q('.status .signin').textContent()).trim(), 'Open sotrep.com');
    check('captcha: the card says what to do', /captcha/.test(await one.locator('.react').textContent()), await one.locator('.react').textContent());
    const sent = await page.evaluate(() => __rx);
    await one.locator('.react button:has-text("Reload")').click();
    await page.waitForTimeout(1900);
    eq('captcha: nothing more is sent until you come back', await page.evaluate(() => __rx), sent);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(300);
    await one.locator('.react button:has-text("Reload")').click();
    await page.waitForTimeout(1900);
    eq('captcha: back on the tab, React works again', await one.locator('.rchip').count(), 4);
    eq('no page errors on a reaction captcha', errors, []);
    await ctx.close();
  }

  // ----- names that arrived while the board was closed -----
  {
    const extra = (n) => Array.from({ length: n }, (_, i) => ({ Gamertag: `Away Crew ${i + 1}`, IsOnline: true, IsPlayingSot: true, DisplayPicUrl: '' }));
    const withList = (n) => ({ recent: () => ({ body: JSON.stringify([...extra(n), ...demo.list]) }) });
    const searches = (page) => page.evaluate(() => __calls.filter(u => u.includes('/api/search')).length);
    // opened after a long break: 40 new names, none looked up, none on Recent
    const old = { ...demo.store(), lastPollAt: new Date(Date.now() - 3 * 3600e3).toISOString() };
    const a = await fresh(browser, old, 'dark', withList(40));
    await a.page.waitForTimeout(4000);
    eq('closed board: nobody new goes on Recent', await a.q('.list .row:has-text("Away Crew")').count(), 0);
    eq('closed board: nobody is looked up', await searches(a.page), 0);
    await a.q('button.tab:has-text("History")').click();
    check('closed board: they wait in their own group in History', /Met while the board was closed\s*40/.test(await a.q('.list').textContent()), 'no group');
    await a.q('.tsec.fold:has-text("Met while the board was closed")').click();
    eq('each with a Look up button', await a.q('.list .row:has-text("Away Crew") button:has-text("Look up")').count(), 40);
    eq('no page errors on catch-up', a.errors, []);
    await a.ctx.close();
    // the board was open a minute ago (a refresh): three new names are real meetings
    const recentRead = { ...demo.store(), lastPollAt: new Date(Date.now() - 60e3).toISOString() };
    const b = await fresh(browser, recentRead, 'dark', withList(3));
    await b.page.waitForTimeout(4000);
    eq('board just open: new names go on Recent', await b.q('.list .row:has-text("Away Crew")').count(), 3);
    check('and get looked up one at a time', (await searches(b.page)) >= 1, 'no lookup');
    await b.ctx.close();
    // more than 30 unknown names in one read is a catch-up even with the board open
    const c = await fresh(browser, recentRead, 'dark', withList(31));
    await c.page.waitForTimeout(4000);
    eq('31 at once: treated as a catch-up', [await c.q('.list .row:has-text("Away Crew")').count(), await searches(c.page)], [0, 0]);
    // a backup carries the marker: restored elsewhere, away names stay away
    const exported = await c.page.evaluate(() => JSON.parse(JSON.stringify(__store)));
    check('the marker is kept for away names', exported.awayStamps.length === 1 && exported.awayStamps[0] === exported.seen['Away Crew 1'], JSON.stringify(exported.awayStamps));
    await c.q('button[title="Settings"]').click();
    const [dl] = await Promise.all([c.page.waitForEvent('download'), c.q('button:has-text("Export backup")').click()]);
    const bf = path.join(os.tmpdir(), 'sotrep-live-test-away.json');
    await dl.saveAs(bf);
    check('the backup holds the marker', JSON.parse(fs.readFileSync(bf, 'utf8')).awayStamps.length === 1, 'missing');
    const emptyB = { ...demo.store(), seen: {}, cache: {}, meets: {}, baselined: false, baselineAt: null, inList: null };
    const e = await fresh(browser, emptyB);
    await e.q('button[title="Settings"]').click();
    await e.q('input[type=file]').setInputFiles(bf);
    await e.page.waitForTimeout(500);
    eq('imported away names keep the marker', await e.page.evaluate(() => __store.awayStamps.includes(__store.seen['Away Crew 1'])), true);
    await e.ctx.close();
    await c.ctx.close();
  }

  // ----- a board left open while the PC slept -----
  {
    let more = false;
    const extra = Array.from({ length: 5 }, (_, i) => ({ Gamertag: `Sleep Crew ${i + 1}`, IsOnline: true, IsPlayingSot: true, DisplayPicUrl: '' }));
    const st = { ...demo.store(), lastPollAt: new Date(Date.now() - 60e3).toISOString() };
    const init = `window.__skew = 0; const now = Date.now.bind(Date); Date.now = () => now() + window.__skew;`;
    const { ctx, page, q } = await fresh(browser, st, 'dark', { initScript: init, recent: () => more ? { body: JSON.stringify([...extra, ...demo.list]) } : null });
    await page.waitForTimeout(1500);
    more = true;
    await page.evaluate(() => { window.__skew = 15 * 60e3; document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(2500);
    eq('woke after 15 minutes: names met meanwhile are not on Recent', await q('.list .row:has-text("Sleep Crew")').count(), 0);
    eq('and are not looked up', await page.evaluate(() => __calls.filter(u => u.includes('/api/search')).length), 0);
    await ctx.close();
  }

  // ----- Clear board survives a refresh -----
  {
    const a = await fresh(browser);
    await a.q('button[title="Settings"]').click();
    await a.q('.panel button:has-text("Clear board")').click();
    const after = await a.page.evaluate(() => JSON.parse(JSON.stringify(__store)));
    await a.ctx.close();
    const b = await fresh(browser, after);
    eq('cleared board stays empty after a refresh', await b.q('.list .row').count(), 0);
    await b.ctx.close();
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
    eq('no fast retries while signed out (the 5 minute fallback has not fired)', recentCalls, 2);
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

  // ----- the button stays visible on a narrow window -----
  {
    const { ctx, page, q } = await fresh(browser, demo.store(), 'dark', { recent: () => ({ status: 401, body: '{}' }) });
    await page.setViewportSize({ width: 420, height: 700 });
    await page.waitForTimeout(400);
    const fits = await q('.status').evaluate((st) => { const b = st.querySelector('.signin').getBoundingClientRect(), s = st.getBoundingClientRect(); return b.width > 20 && b.left >= s.left - 1 && b.right <= s.right + 1; });
    check('Sign in button not clipped on a narrow window', fits, 'clipped');
    await ctx.close();
  }

  // ----- a first "not live" from Twitch gets one quick second look -----
  {
    const init = `
      window.__skew = 0; window.__tw = 'off';
      const now = Date.now.bind(Date); Date.now = () => now() + window.__skew;
      const real = window.GM_xmlhttpRequest;
      window.GM_xmlhttpRequest = (o) => {
        if (!o.url.includes('twitch.tv/playertwo')) return real(o);
        window.__calls.push(o.url);
        setTimeout(() => o.onload({ status: 200, responseText: window.__tw === 'live' ? '"isLiveBroadcast":true' : '<html></html>', responseHeaders: '' }), 20);
      };`;
    const { ctx, page, q, errors } = await fresh(browser, demo.store(), 'dark', { initScript: init });
    const tw = () => page.evaluate(() => __calls.filter(u => u.includes('twitch.tv/playertwo')).length);
    eq('first Twitch check made', await tw(), 1);
    eq('not live at first', await q('.row .tag.live').count(), 0);
    await page.evaluate(() => { window.__skew += 30e3; });
    await page.waitForTimeout(22000);
    eq('no second check inside a minute', await tw(), 1);
    await page.evaluate(() => { window.__tw = 'live'; window.__skew += 40e3; });
    await page.waitForTimeout(22000);
    eq('second check after a minute', await tw(), 2);
    eq('LIVE shows on the second look', await q('.row .tag.live').count(), 1);
    await page.evaluate(() => { window.__tw = 'off'; window.__skew += 90e3; });
    await page.waitForTimeout(22000);
    eq('then back to every five minutes', await tw(), 2);
    eq('no page errors on the Twitch recheck', errors, []);
    await ctx.close();
  }

  // ----- both buttons stay visible on a narrow window -----
  {
    const st = { ...demo.store(), me: null };   // the first sotrep request is our own gamertag, and it gets a 401
    const { ctx, page, q } = await fresh(browser, st, 'dark', { recent: () => ({ status: 401, body: '{}' }), initScript: 'window.__searchStatus = 401;' });
    await page.setViewportSize({ width: 420, height: 700 });
    await page.waitForTimeout(4500);
    const r = await q('.status').evaluate((st) => {
      const s = st.getBoundingClientRect();
      return [...st.querySelectorAll('.signin')].map(e => { const b = e.getBoundingClientRect(); return b.width > 20 && b.left >= s.left - 1 && b.right <= s.right + 1 && b.bottom <= s.bottom + 1; });
    });
    eq('both Sign in buttons fully visible on a narrow window', r, [true, true]);
    await ctx.close();
  }

  // ----- a refresh keeps the whole session -----
  {
    const t = (m) => new Date(Date.now() - m * 60e3).toISOString();
    const six = ['Player One', 'Player Two', 'Player Three', 'Player Four', 'Player Five', 'Player Six'];
    const withTimes = (mins) => { const st = demo.store(); six.forEach((gt, i) => { st.seen[gt] = t(mins[i]); }); return st; };
    // gaps: 5 -> 40 -> 100 are all under 90 minutes apart, 100 -> 300 is not, the rest are long ago
    const a = await fresh(browser, withTimes([5, 40, 100, 300, 1000, 1100]));
    eq('session kept across gaps under 90 minutes, older session left out', await a.q('.list .row').count(), 3);
    await a.ctx.close();
    const b = await fresh(browser, withTimes([200, 250, 300, 400, 1000, 1100]));
    eq('a new evening starts with an empty board', await b.q('.list .row').count(), 0);
    await b.ctx.close();
  }

  // ----- signed out of sotrep.com with nothing queued -----
  for (const [label, status, body, want] of [['200', 200, JSON.stringify({ gamertag: 'Me', xuid: '42' }), null], ['captcha 403', 403, '{"require_captcha":true}', 'Open sotrep.com']]) {
    const st = { ...demo.store(), me: null };   // no stored Xbox ID, so the first sotrep request is our own gamertag
    const { ctx, page, q } = await fresh(browser, st, 'dark', { initScript: 'window.__searchStatus = 401;' });
    await page.waitForTimeout(4500);
    eq(`empty queue (${label}): signed-out button shown`, (await q('.status .signin').textContent()).trim(), 'Sign in to sotrep.com');
    await page.evaluate(([s, b]) => { window.__searchStatus = s; window.__searchBody = b; window.dispatchEvent(new Event('focus')); }, [status, body]);
    await page.waitForTimeout(1200);
    const btns = await q('.status .signin').allTextContents();
    eq(`empty queue (${label}): recovery probe clears the sign-in button`, btns.map(x => x.trim()), want ? [want] : []);
    if (!want) eq('empty queue (200): probe keeps the Xbox ID so the presence check does not search again', await page.evaluate(() => __store.me), { gt: 'Me', xuid: '42' });
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

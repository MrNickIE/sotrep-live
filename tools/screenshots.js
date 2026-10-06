// Makes the README screenshots from made-up players. Nothing leaves the machine: every request the
// script would make (seaofthieves.com, sotrep.com, Twitch, GitHub) is answered locally with demo data.
// Names, socials and pictures are blurred so no placeholder can be mistaken for a real player.
// Run from the repo root: NODE_PATH=$(npm root -g) node tools/screenshots.js
const path = require('path');
const { chromium } = require('playwright');
const demo = require('./demo');

const OUT = path.join(demo.ROOT, 'images');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const shadow = await demo.open(page);

  await page.waitForTimeout(6000);   // first poll, the Twitch check and the Xbox presence pill
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.textContent = '.name,.soc,.pic{filter:blur(5px)}';
    document.getElementById('sotrep-live-host').shadowRoot.append(s);
  });
  const fit = async (sel = '.list', pad = -16) => ({ x: 0, y: 0, width: 1280, height: Math.min(page.viewportSize().height, Math.ceil(await shadow(sel).evaluate(e => e.getBoundingClientRect().bottom)) + pad) });
  await page.screenshot({ path: path.join(OUT, 'board.png'), clip: await fit() });

  await page.setViewportSize({ width: 1280, height: 1000 });   // the settings panel is tall
  await shadow('button[title="Settings"]').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'settings.png'), clip: await fit('.panel', 0) });
  await shadow('button[title="Settings"]').click();
  await page.setViewportSize({ width: 1280, height: 760 });

  await shadow('button.tab:has-text("History")').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'history.png'), clip: await fit() });

  // light theme, compact layout, History filtered to players met more than once
  await shadow('button.tab:has-text("Light")').evaluate(b => b.click());
  await shadow('button.tab:has-text("Compact")').evaluate(b => b.click());
  await shadow('.filters .toggle:has-text("Met more than once") input').evaluate(c => c.click());
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'light.png'), clip: await fit() });

  await browser.close();
  console.log('Saved board.png, settings.png, history.png and light.png in images/');
})();

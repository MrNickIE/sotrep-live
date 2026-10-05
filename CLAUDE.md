# Working on SOTREP Live

Single-file Tampermonkey userscript (`sotrep-live.user.js`) that turns the seaofthieves.com friends page into a live board of players you meet, with their SoT Rep reputation. Owner: Nick (MrNickIE). He directs, Claude builds.

## Rules that always apply

- **Not affiliated.** Nick is not part of the SoT Rep team. Nothing in the README, release notes or UI may imply the tool is affiliated with or endorsed by SoT Rep, Rare or Microsoft.
- **Never risk a ban or block.** Every outbound request needs a reason, a frequency and a back-off. Current budget:
  - seaofthieves.com `get-recent-friends`: adaptive polling (20 s while the list changes, 60 s after 10 quiet minutes, 180 s when hidden and quiet 30 min), 20 s timeout, back-off on 401/403/429/5xx, watchdog restarts a stalled loop.
  - sotrep.com: one lookup per new name, 3 s apart, cached 24 h, Retry-After honoured, errored rows never auto-retried. No bulk lookup, ever (Nick's decision). Own presence via `xbl-info` every 5 min visible, 15 min hidden.
  - twitch.tv: one channel page per live-checked streamer every 5 min, only for the Recent board.
  - GitHub: meta file check every 6 h.
- **Writing:** UK English. No em dashes or en dashes anywhere (code comments, README, commits, release notes). Plain short commit messages that do not read as AI. Never add a Co-Authored-By trailer or a Claude session link to commits or PRs.
- **Browsers:** must work in Chrome and Firefox. Firefox rejects `min()` inside `repeat()` in CSS grid.
- **Users install from the link only**, never by pasting the file. Keep the install link front and centre in the README.

## How releases work

Install link: `https://github.com/MrNickIE/sotrep-live/releases/latest/download/sotrep-live.user.js`

- `@downloadURL` points at the latest release asset (GitHub counts these downloads, which is how Nick sees usage).
- `@updateURL` points at `sotrep-live.meta.js` on `main` (header only, not counted). Tampermonkey checks it, then downloads the release asset when the version is newer.

To ship version X.Y.Z:

1. Bump `// @version` in `sotrep-live.user.js`.
2. Regenerate the meta file: `sed -n '/==UserScript==/,/==\/UserScript==/p' sotrep-live.user.js > sotrep-live.meta.js`
3. Syntax check: `node -e "new Function(require('fs').readFileSync('sotrep-live.user.js','utf8').replace(/GM_\w+/g,'undefined'))"`
4. Check for dashes: `grep -cP '\x{2014}|\x{2013}' sotrep-live.user.js README.md` should print 0 for each file.
5. Commit both files, tag `vX.Y.Z`, push, and create a GitHub release for the tag with `sotrep-live.user.js` attached as an asset. The release must exist before (or at the same moment as) the new meta file goes live, otherwise Tampermonkey sees a new version but downloads the old asset.

First job for a Claude Code session: add a GitHub Action that builds the release automatically when a `v*` tag is pushed, attaching `sotrep-live.user.js`, so shipping is just "bump, commit, tag, push".

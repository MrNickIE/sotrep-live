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
3. Run the checks locally (the Action runs them too):
   - Syntax: `node -e "new Function(require('fs').readFileSync('sotrep-live.user.js','utf8').replace(/GM_\w+/g,'undefined'))"`
   - Dashes: `LC_ALL=C.UTF-8 grep -cP '\x{2014}|\x{2013}' sotrep-live.user.js README.md` should print 0 for each file.
4. Commit both files on `main` and tag: `git tag vX.Y.Z`.
5. Push the tag first: `git push origin vX.Y.Z`. The Release Action (`.github/workflows/release.yml`) checks the tag matches `@version`, the meta file matches the header, the syntax and the dashes, then creates the release with `sotrep-live.user.js` attached.
6. Once the Action is green and the release exists, push `main`: `git push origin main`. This puts the new meta file live.

Order matters: the release must exist before the new meta file goes live on `main`, otherwise Tampermonkey sees a new version but downloads the old asset. Pushing the tag first guarantees that. If a check fails, no release is made; fix it, move the tag (`git tag -f vX.Y.Z`, `git push -f origin vX.Y.Z`) and the Action runs again.

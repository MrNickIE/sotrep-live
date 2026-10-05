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
4. Refresh the README screenshots: `NODE_PATH=$(npm root -g) node tools/screenshots.js`, then look at all three images before committing (blur on, nothing broken, new features visible). Do this every release; the version pill is in the shots, so they go stale otherwise. If a new feature deserves its own picture, add a step to `tools/screenshots.js` and a line in the README.
5. Commit the script, meta file and images on a branch and push the branch. Do not merge to `main` yet. Write the commit messages for users: the release notes are built from the subjects of commits that changed `sotrep-live.user.js` since the last release.
6. Run the Release workflow (`.github/workflows/release.yml`) on that branch: the `run_workflow` GitHub tool with workflow `release.yml` and ref set to the branch, or the Run workflow button on the Actions tab. It reads `@version`, refuses if that release already exists, checks the meta file, syntax and dashes, then tags the commit `vX.Y.Z` and creates the release with `sotrep-live.user.js` attached. Claude Code sessions cannot push tags, so use this route rather than `git push origin vX.Y.Z` (which also works, from a normal machine).
7. Confirm the run is green and the release has the asset, then merge the branch into `main`. This puts the new meta file live.

Order matters: the release must exist before the new meta file goes live on `main`, otherwise Tampermonkey sees a new version but downloads the old asset. Releasing from the branch before merging guarantees that. If a check fails, no release is made; fix it on the branch and run the workflow again.

## README screenshots

`images/*.png` are made by `tools/screenshots.js` (run `NODE_PATH=$(npm root -g) node tools/screenshots.js` from the repo root; needs Playwright). It loads the real script against made-up players with every outbound request answered locally, and blurs names, socials and pictures. Re-run it on every release (step 4 above) and after any visible UI change. Never use invented gamertags that could belong to real players without the blur, and never put real players in the README.

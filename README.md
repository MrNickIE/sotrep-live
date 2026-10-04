# SOTREP Live

A Tampermonkey userscript that shows the Sea of Thieves players you meet, live, with their [SoT Rep](https://www.sotrep.com) reputation.

It turns `https://www.seaofthieves.com/friends` into a second-screen board. While you play, any new name that lands in Rare's "Recently Met" list appears at the top, colour-coded by SOTREP reputation, with a link to the player's profile.

Personal tool. Not affiliated with Rare or Microsoft.

## How it works

- Every 20 seconds it reads Rare's own `Recently Met` data (`/api/users/get-recent-friends`) using your normal seaofthieves.com login.
- Any gamertag it has not seen before is a new encounter. It is looked up on sotrep.com (`POST /api/search`) using your sotrep.com login and shown on the board.
- Lookups run one at a time, 1.5 s apart, and are cached for 24 hours. There is deliberately no bulk lookup.
- The first run takes the current list (around 180 names) as a baseline and does not look any of them up, so the board only shows genuinely new encounters.
- Nothing touches the game client. The two calls are the same ones the two websites make themselves.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome.
2. In `chrome://extensions`, open Tampermonkey's details and turn on **Allow User Scripts** (older Chrome: the **Developer mode** toggle). Without this userscripts never run.
3. Tampermonkey icon, **Create a new script**, replace the template with the contents of `sotrep-live.user.js`, save.
4. Make sure you are signed in to both seaofthieves.com and sotrep.com in that browser.
5. Open `https://www.seaofthieves.com/friends`. Allow the one-time request to connect to sotrep.com.

## Using it

- **Recent** shows players first seen in the last 20 minutes (survives a refresh).
- **History** shows everyone ever recorded, newest first, with a **Look up** button on anyone not yet checked. Names from the baseline sit in a collapsed group at the bottom.
- **Check a gamertag** looks up any name you type, for players you spot in game before Rare registers them.
- **Alerts** sends a desktop notification when a new player is orange (moderate) or red (severe or banned accounts).
- **Clear** empties the Recent board. **Reset** (press twice) forgets everything and re-baselines.

Left edge and reputation text: green clean, yellow light flags, orange moderate, red severe or banned accounts.

## Limits

- Rare's list has no timestamps and no "met again" signal, so a player you met before tracking started never shows as new. Use History or Check a gamertag for those.
- Online / Offline / Playing SoT comes from Rare, which gets it from Xbox Live presence, so it follows the other player's privacy settings.
- Pictures come from Rare's list; manual lookups get a lettered placeholder unless sotrep.com holds an image.

## Also in this repo

`Dump-RecentPlayerEvents.ps1` is a fallback diagnostic from before the friends endpoint was found. It captures the Windows WinHTTP trace the original SOTREP recent-players script relied on. Not needed for normal use.

# SOTREP Live

A Tampermonkey userscript that shows the Sea of Thieves players you meet, live, with their [SoT Rep](https://www.sotrep.com) reputation.

It turns `https://www.seaofthieves.com/friends` into a second-screen board. While you play, any new name that lands in Rare's "Recently Met" list appears at the top, colour-coded by SOTREP reputation, with a link to the player's profile.

Independent personal tool. Not affiliated with, or endorsed by, SoT Rep, Rare or Microsoft. It uses no special access: everything it does, you could do by hand in two browser tabs.

## How it works

- Every 20 seconds it reads the same `Recently Met` data the seaofthieves.com friends page shows, using your normal seaofthieves.com login.
- Any gamertag it has not seen before is a new encounter. It is looked up on sotrep.com the same way the site's own search box does, using your sotrep.com login, and shown on the board.
- Lookups run one at a time, 1.5 s apart, and are cached for 24 hours. There is deliberately no bulk lookup.
- The first run takes the current list (around 180 names) as a baseline and does not look any of them up, so the board only shows genuinely new encounters.
- Nothing touches the game client. The two calls are the same ones the two websites make themselves.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome.
2. In `chrome://extensions`, open Tampermonkey's details and turn on **Allow User Scripts** (older Chrome: the **Developer mode** toggle). Without this userscripts never run.
3. Open the raw script and Tampermonkey will offer to install it:
   `https://raw.githubusercontent.com/MrNickIE/sotrep-live/main/sotrep-live.user.js`
4. Make sure you are signed in to both seaofthieves.com and sotrep.com in that browser.
5. Open `https://www.seaofthieves.com/friends`. Allow the one-time request to connect to sotrep.com.

The script carries `@updateURL` / `@downloadURL` pointing back at this repo, so Tampermonkey picks up new versions on its own (daily by default; Tampermonkey menu, **Check for userscript updates**, for an instant pull). Updating means pushing a new `@version` to `main`.

## Using it

- **Recent** shows players first seen in the last 20 minutes (survives a refresh).
- **History** shows everyone ever recorded, newest first, with a **Look up** button on anyone not yet checked. Names from the baseline sit in a collapsed group at the bottom.
- **Check a gamertag** looks up any name you type, for players you spot in game before Rare registers them.
- **Alerts** opens the alert settings. A chime plays in the tab by default when a new player is orange (moderate) or red (severe or banned accounts); you can narrow it to red only. Paste a Discord webhook URL to have flagged players posted to a private channel with the rep summary and a profile link, which is the reliable route while a game has the screen. A Windows desktop notification is also available but is hidden behind a full-screen game. **Test alerts** fires every enabled channel once.
- **Streamers**: a player whose sotrep profile links a Twitch channel is checked against Twitch when they appear and every five minutes while on the Recent board. If they are live, the row gets a purple **LIVE on Twitch** pill that opens the stream, and the streamer alert fires (chime, Discord embed with the stream link). Offline streamers just show their Twitch link. The panel has a box to test the live check against any channel name.
- **Clear** empties the Recent board. **Reset** (press twice) forgets everything and re-baselines.

Left edge and reputation text: green clean, yellow light flags, orange moderate, red severe or banned accounts.

## Limits

- Rare's list has no timestamps and no "met again" signal, so a player you met before tracking started never shows as new. Use History or Check a gamertag for those.
- Online / Offline / Playing SoT comes from Rare, which gets it from Xbox Live presence, so it follows the other player's privacy settings.
- Pictures come from Rare's list; manual lookups get a lettered placeholder unless sotrep.com holds an image.

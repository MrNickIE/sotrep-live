# SOTREP Live

![Downloads](https://img.shields.io/github/downloads/MrNickIE/sotrep-live/total?label=installs%20%2B%20updates) ![Latest release](https://img.shields.io/github/v/release/MrNickIE/sotrep-live?label=latest)

## Install from this link, nothing else

**https://github.com/MrNickIE/sotrep-live/releases/latest/download/sotrep-live.user.js**

Open it in Chrome with [Tampermonkey](https://www.tampermonkey.net/) installed and click **Install**. It then updates itself whenever a new version is pushed here.

**Do not download the file and paste it into Tampermonkey.** You end up on a frozen copy with no updates. If you already did, delete that copy and use the link.

A Tampermonkey userscript that shows the Sea of Thieves players you meet, live, with their [SoT Rep](https://www.sotrep.com) reputation.

It turns `https://www.seaofthieves.com/friends` into a second-screen board. While you play, any new name that lands in Rare's "Recently Met" list appears at the top, colour-coded by SOTREP reputation, with a link to the player's profile.

Independent personal tool. Not affiliated with, or endorsed by, SoT Rep, Rare or Microsoft. It uses no special access: everything it does, you could do by hand in two browser tabs.

## How it works

- It reads the same `Recently Met` data the seaofthieves.com friends page shows, using your normal seaofthieves.com login: every 20 seconds while you are meeting people, once a minute after ten quiet minutes, every three minutes when the tab is hidden and nothing has changed for half an hour. It backs off for several minutes if the site asks it to.
- Any gamertag it has not seen before is a new encounter. It is looked up on sotrep.com the same way the site's own search box does, using your sotrep.com login, and shown on the board.
- Lookups run one at a time, 3 s apart, and are cached for 24 hours. A new player normally costs one request. There is deliberately no bulk lookup. If sotrep.com rate-limits you anyway, the board pauses lookups for the time it asks and carries on afterwards; the status line says so.
- The first run takes the current list (around 180 names) as a baseline and does not look any of them up, so the board only shows genuinely new encounters.
- Nothing touches the game client. The two calls are the same ones the two websites make themselves.

## Setup, step by step

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome.
2. In `chrome://extensions`, open Tampermonkey's details and turn on **Allow User Scripts** (older Chrome: the **Developer mode** toggle). Without this userscripts never run.
3. Open the install link at the top of this page and click **Install**.
4. Make sure you are signed in to both seaofthieves.com and sotrep.com in that browser.
5. Open `https://www.seaofthieves.com/friends`. Allow the one-time requests to connect to sotrep.com (and twitch.tv, discord.com if you use those alerts).

Updates arrive on their own, usually within a day. Tampermonkey menu, **Check for userscript updates**, pulls one immediately.

### Firefox and other browsers

Works the same in Firefox with the [Tampermonkey add-on](https://addons.mozilla.org/firefox/addon/tampermonkey/): install the add-on, open the install link at the top, click Install. Skip step 2 above; that toggle is a Chrome thing. Edge and Brave behave like Chrome, including step 2. Violentmonkey should also work but is untested; Greasemonkey will not, as it lacks the `GM_` functions this script uses.

Whatever the browser, allow the one-time requests Tampermonkey shows for sotrep.com (and twitch.tv, discord.com if you use those alerts). If a lookup sits on "queued…" for ages, that prompt is waiting for you: click the Tampermonkey toolbar icon while on the friends tab and choose **Always allow domain**. After 30 seconds the row says so and offers Retry.

## Using it

- **Recent** shows players first seen in the last 20 minutes (survives a refresh).
- **History** shows everyone ever recorded, newest first, with a **Look up** button on anyone not yet checked. Names from the baseline sit in a collapsed group at the bottom.
- **Check a gamertag** looks up any name you type, for players you spot in game before Rare registers them. A Twitch channel name works too: if no pirate has that gamertag, sotrep is asked for the pirate linked to that Twitch account.
- Alerts fire only for players the game registered on its own. Manual lookups (the Check box, History's Look up buttons) never alert.
- **Alerts** opens the alert settings. Tick what you want to be told about: red (severe flags or banned accounts), orange (moderate flags), purple (a linked streamer who is live), in any mix. A chime plays in the tab by default. Paste a Discord webhook URL to have flagged players posted to a private channel with the rep summary and a profile link, which is the reliable route while a game has the screen. A Windows desktop notification is also available but is hidden behind a full-screen game. **Test alerts** fires every enabled channel once.
- **Streamers**: a player whose sotrep profile links a Twitch channel is checked against Twitch when they appear and every five minutes while on the Recent board. If they are live, the row gets a purple **LIVE on Twitch** pill that opens the stream, and the streamer alert fires (chime, Discord embed with the stream link). Offline streamers just show their Twitch link. The panel has a box to test the live check against any channel name.
- **Clear** empties the Recent board. **Reset** (press twice) forgets everything and re-baselines.

Left edge and reputation text: green clean, yellow light flags, orange moderate, red severe or banned accounts.

## Limits

- Rare's list has no timestamps and no direct "met again" signal. The board infers it: the list is capped and rolling, so a name that has dropped off and comes back is treated as meeting them again (back to the top of Recent, alerts apply). Someone you met very recently who is still in the list will not re-trigger; they are already on Recent. Players from before tracking started show as new only once they have dropped off and returned.
- "Online" and "Playing SoT" come from Rare, which gets them from Xbox Live presence, so they only appear when the other player's privacy settings allow it. When Xbox shares nothing the row shows just the time you met them; it never claims someone is offline, since they were on your server when they appeared.
- Pictures come from Rare's list; manual lookups get a lettered placeholder unless sotrep.com holds an image.

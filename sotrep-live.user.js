// ==UserScript==
// @name         SOTREP Live - players I meet
// @namespace    https://www.sotrep.com/
// @version      2.1.0
// @description  Watches the Sea of Thieves "Recently Met" list and shows each newly met player with their SOTREP reputation, live, while you play.
// @homepageURL  https://github.com/MrNickIE/sotrep-live
// @updateURL    https://raw.githubusercontent.com/MrNickIE/sotrep-live/main/sotrep-live.meta.js
// @downloadURL  https://github.com/MrNickIE/sotrep-live/releases/latest/download/sotrep-live.user.js
// @match        https://www.seaofthieves.com/friends*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_info
// @connect      www.sotrep.com
// @connect      sotrep.com
// @connect      discord.com
// @connect      discordapp.com
// @connect      twitch.tv
// @connect      www.twitch.tv
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

/*
  How it works
  - Polls https://www.seaofthieves.com/api/users/get-recent-friends (your own login) every POLL_SECONDS.
  - Any gamertag not seen before is a new encounter. It is looked up on sotrep.com via POST /api/search
    (again your own login) and shown at the top of the board with a colour-coded reputation.
  - Everything is cached locally so a player is only looked up once per CACHE_HOURS.
  - Players from the current session stay on the board across a page refresh. A session follows your own Xbox status when
    it is visible, otherwise it is a run of meetings with no gap over SESSION_GAP_MS (90 minutes). See sessionOf.
  - History view lists every name ever recorded, newest first, with a per-row "Look up" button for anyone
    not yet checked. There is deliberately no bulk lookup, to stay gentle on sotrep.com.
  - Reset needs two presses: the first arms the button for a few seconds, the second fires.
  - The board renders inside a Shadow DOM so the Sea of Thieves site styles cannot leak into it.
  - Nothing touches the game. Both calls are the same ones the two websites make themselves.

  First run: the current list (up to ~180 names) is taken as the baseline and NOT looked up, so you only see
  genuinely new encounters from now on. Those names sit in a collapsed group at the bottom of History.
*/

(function () {
  'use strict';

  const POLL_SECONDS = 20;        // how often to re-read Recently Met
  const CACHE_HOURS = 24;         // how long a SOTREP lookup is trusted before re-checking
  const LOOKUP_GAP_MS = 3000;     // pause between SOTREP lookups so we never hammer the site (their rate limiter bites below this)
  const SESSION_GAP_MS = 90 * 60e3;   // a run of meetings with no gap over this is one session; a refresh keeps the whole session on the board
  const RECENT_MAX = 100;             // most players restored to the board after a refresh
  const SIGNIN_FALLBACK_MS = 5 * 60e3; // signed out of seaofthieves.com: slowest safety-net retry for a tab that never loses focus
  const SOTREP = 'https://www.sotrep.com';
  const RECENT_URL = '/api/users/get-recent-friends';

  // ---------- persistent state ----------
  const state = {
    seen: GM_getValue('seen', {}),        // gamertag -> first seen ISO time
    cache: GM_getValue('cache', {}),      // gamertag -> { at, rep }
    baselined: GM_getValue('baselined', false),
    baselineAt: GM_getValue('baselineAt', null),   // ISO stamp shared by every name in the first poll
    me: GM_getValue('me', null),                   // { gt, xuid } for the signed-in player, so the Xbox ID lookup happens once
    inList: GM_getValue('inList', null),           // gamertag -> true for everyone present at the last poll (null until first poll)
    missing: GM_getValue('missing', {}),           // gamertag -> consecutive polls absent from the list
    lives: GM_getValue('lives', {}),               // gamertag -> ISO time a Twitch check last found them live (last 30 days)
    play: GM_getValue('play', null),               // { start, last, seenStart }: the latest stretch your Xbox status said you were playing SoT
    meets: GM_getValue('meets', {}),               // gamertag -> ISO times you met them (last 30 days, newest last)
    ui: Object.assign({ theme: 'dark', layout: 'comfortable', pinRed: true }, GM_getValue('ui', {})),
    lastVersion: GM_getValue('lastVersion', null), // the version that last ran, so "what's new" shows once per update
    alerts: Object.assign(
      { sound: true, discord: '', desktop: false, severe: true, moderate: true, streamers: true },
      GM_getValue('alerts', {}),
    ),
  };
  // older versions stored a single threshold; carry it over once
  if (state.alerts.threshold) { state.alerts.moderate = state.alerts.threshold === 'moderate'; delete state.alerts.threshold; }
  // Writes only the keys named, or everything. seen and cache grow with every player met, so the 20 s poll and
  // each lookup write just what they touched rather than re-serialising the lot.
  const save = (keys = Object.keys(state)) => { for (const k of keys) GM_setValue(k, state[k]); };
  // A sotrep reply older than 30 days is cut down to what History needs (colour and label). Socials, tags and alts
  // go, so storage stops growing with every player ever met. Anyone met again is past the 24 h cache and looked up fresh.
  {
    const cutoff = Date.now() - 30 * 864e5;
    const KEEP = ['severe_count', 'moderate_count', 'light_count', 'banned_xuids', 'reputation_override', 'profile_id', 'error'];
    let trimmed = false;
    for (const c of Object.values(state.cache)) {
      if (!c || !c.rep || c.trimmed || !(c.at < cutoff)) continue;
      c.rep = Object.fromEntries(KEEP.filter(k => k in c.rep).map(k => [k, c.rep[k]]));
      c.trimmed = true;
      trimmed = true;
    }
    if (trimmed) save(['cache']);
  }
  // The meeting log keeps 30 days and 30 entries a player, so it stays small however long the script runs.
  {
    const cutoff = Date.now() - 30 * 864e5;
    let pruned = false;
    for (const [gt, arr] of Object.entries(state.meets)) {
      const keep = Array.isArray(arr) ? arr.filter(t => Date.parse(t) >= cutoff).slice(-30) : [];
      if (!Array.isArray(arr) || keep.length !== arr.length) { pruned = true; if (keep.length) state.meets[gt] = keep; else delete state.meets[gt]; }
    }
    for (const [gt, t] of Object.entries(state.lives)) if (!(Date.parse(t) >= cutoff)) { delete state.lives[gt]; pruned = true; }
    if (pruned) save(['meets', 'lives']);
  }

  // in-memory
  const session = {
    order: [],          // gamertags on the board, newest first
    current: new Map(), // gamertag -> {IsOnline, IsPlayingSot, DisplayPicUrl}
    queue: [],
    busy: false,
    lastPoll: null,
    count: 0,
    view: 'recent',     // 'recent' | 'history'
    hist: { q: '', colour: 'all', streamers: false, repeat: false },   // History search and filters
    manual: new Set(),  // gamertags looked up by hand (Check box, History button): never alert on these
    live: new Map(),    // twitch login -> { at, live, title, url }
    react: new Map(),   // Xbox ID -> your reactions panel for that player (this page session only)
    socOpen: new Set(), // gamertags whose full list of socials is open
    liveQueue: [],
    liveBusy: false,
    signedOut: false,       // seaofthieves.com said 401/403: no fast polling; retries on return to the tab, or every SIGNIN_FALLBACK_MS
    sotrepSignedOut: false, // sotrep.com said 401: lookups are parked until you come back to this tab
    pauseFix: false,        // the current sotrep pause is one you can clear yourself on sotrep.com (captcha, finish sign-up)
    sotrepTry: false,       // one lookup is allowed through to find out whether you have signed in
  };
  const LIVE_TTL_MS = 5 * 60e3;       // how long a Twitch live/offline answer is trusted
  const LIVE_GAP_MS = 2000;           // pause between Twitch page checks
  const LIVE_FIRST_RECHECK_MS = 60e3; // a first check that says not live (or fails) is trusted only this long, once per streamer

  // ---------- what counts as a session ----------
  // Best: your own Xbox status, which the presence check already reads every 5 minutes (15 when the tab is hidden).
  // Checks that say you are playing SoT make one sitting. It ends after two "not playing" readings in a row, or
  // PLAY_END_MS with no playing reading at all, so one late or odd answer from Xbox never splits a sitting. When the
  // board saw a sitting begin, it starts just after the last reading that said you were not playing, which keeps two
  // sittings in one evening apart without losing players met before the first playing check. When the page opened
  // mid-game, it reaches back to the first meeting as well.
  // Fallback, when Xbox shares nothing: a run of meetings with no gap over SESSION_GAP_MS (90 minutes).
  const PLAY_END_MS = 35 * 60e3;   // two hidden-tab checks (15 min apart) plus slack
  const XBOX_LAG_MS = 10 * 60e3;   // only for sittings saved before the boundary was stored
  function playSpan() {
    const p = state.play;
    if (!p || typeof p !== 'object') return null;
    const start = Date.parse(p.start), last = Date.parse(p.last), from = Date.parse(p.from);
    if (!(start > 0) || !(last >= start)) return null;
    const seenStart = p.seenStart === true;
    return { start, last, seenStart, from: seenStart ? (from > 0 && from <= start ? from : start - XBOX_LAG_MS) : null, offs: p.offs | 0 };
  }
  const spanPlaying = (sp) => !!sp && Date.now() - sp.last < PLAY_END_MS && sp.offs < 2;
  // hits: [[time, gamertag]] newest first. untilNow: the session has to reach the present (a page load), not just
  // the latest meeting. Returns { start, end, members, playing, xbox } or null.
  function sessionOf(hits, untilNow) {
    const now = Date.now(), end = hits.length ? hits[0][0] : 0;
    const members = new Set();
    let start = end, prev = untilNow ? now : end;
    for (const [t, gt] of hits) {
      if (prev - t > SESSION_GAP_MS) break;
      start = t; prev = t; members.add(gt);
    }
    const sp = playSpan();
    if (sp) {
      const playing = spanPlaying(sp);
      const lower = sp.seenStart ? sp.from : sp.start - XBOX_LAG_MS;
      const covers = playing || (!untilNow && !!hits.length && end > lower && end <= sp.last + PLAY_END_MS);
      if (covers) {
        if (sp.seenStart) members.clear();
        for (const [t, gt] of hits) if (t > lower) members.add(gt);
        let first = sp.start;
        for (const [t, gt] of hits) if (members.has(gt) && t < first) first = t;
        if (!sp.seenStart && start && start < first) first = start;
        return { start: first, end: playing ? now : Math.max(end, sp.last), members, playing, xbox: true };
      }
    }
    return members.size ? { start, end, members, playing: false, xbox: false } : null;
  }
  // Restore the whole current session so a refresh does not wipe the board mid-session (see sessionOf).
  // Baseline names (everyone present on the very first poll) are never "recent", whatever their stamp.
  function restoreRecent() {
    const hits = Object.entries(state.seen)
      .filter(([, iso]) => iso !== state.baselineAt && Date.parse(iso) > 0)
      .map(([gt, iso]) => [Date.parse(iso), gt])
      .sort((a, b) => b[0] - a[0]);
    const s = sessionOf(hits, true);
    session.order = s ? hits.filter(([, gt]) => s.members.has(gt)).slice(0, RECENT_MAX).map(([, gt]) => gt) : [];
  }
  restoreRecent();

  // Every time the game registers you meeting someone is logged, which drives "met 4 times" and the session summary.
  // Before 1.0.3 only the latest time was kept, so a player met earlier starts from that one time.
  function recordMeet(gt, now, prevSeen) {
    let a = state.meets[gt];
    if (!a) { a = []; if (prevSeen && prevSeen !== state.baselineAt) a.push(prevSeen); }
    a.push(now);
    state.meets[gt] = a.slice(-30);
  }
  function meetList(gt) {
    const a = state.meets[gt];
    if (a) return a;
    const iso = state.seen[gt];
    return iso && iso !== baselineStamp() ? [iso] : [];
  }

  // ---------- UI (inside a shadow root so site CSS cannot reach it) ----------
  const css = `
    :host{all:initial}
    .root{--c-bg0:#0e1114;--c-bg1:#141920;--c-bg2:#11161c;--c-bg3:#171d26;--c-bg4:#1f2733;--c-sevbg:#1c1416;--c-sevbd:#4a2422;--c-l1:#222a34;--c-l2:#2a3340;--c-l3:#3a4454;--c-fg:#e6e4dd;--c-fgs:#f2f1ec;--c-fg2:#c7cdd6;--c-fg3:#aeb7c2;--c-fg4:#9fb3c8;--c-mute:#8f98a5;--c-mute2:#7b8592;--c-mute3:#69737f;--c-mute4:#56606c;--c-acc:#7fb7ff;--c-accfg:#0b1220;--c-ok:#5cc28c;--c-lt:#d7b545;--c-mod:#eb9150;--c-sev:#ef6b63;--c-ambbg:#3a2d12;--c-amb:#e6b85c;--c-ambbd:#6b4a1a;--c-grnbg:#143426;--c-grn:#6fcf97;--c-grnbd:#1f5a3a;--c-redbg:#44201e;--c-red:#f08a84;--c-tw:#b69cff;--c-twbg:#211936;--c-twbd:#4d3790;color-scheme:dark}
    .root.light{--c-bg0:#f1f3f6;--c-bg1:#ffffff;--c-bg2:#f8f9fb;--c-bg3:#ffffff;--c-bg4:#e6eaf0;--c-sevbg:#fdf3f2;--c-sevbd:#f1c4c0;--c-l1:#e2e6eb;--c-l2:#cdd3db;--c-l3:#b0b8c3;--c-fg:#1b2128;--c-fgs:#0b0f14;--c-fg2:#38414c;--c-fg3:#4a5462;--c-fg4:#4a6078;--c-mute:#5b6676;--c-mute2:#5f6a7a;--c-mute3:#6a7586;--c-mute4:#7c8697;--c-acc:#1d5fc4;--c-accfg:#ffffff;--c-ok:#1b7a4a;--c-lt:#8f7008;--c-mod:#b0540c;--c-sev:#bf3029;--c-ambbg:#fdf0d3;--c-amb:#85600f;--c-ambbd:#e2c071;--c-grnbg:#dcf3e5;--c-grn:#1b7a4a;--c-grnbd:#9dd2b3;--c-redbg:#fbe2e0;--c-red:#b3302a;--c-tw:#6d28d9;--c-twbg:#f3edff;--c-twbd:#cdb8f7;color-scheme:light}
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    .root{position:fixed;inset:0;z-index:2147483000;background:var(--c-bg0);color:var(--c-fg);
      font:14px/1.45 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;overflow-y:auto}
    button,input{font-family:inherit}
    button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid var(--c-acc);outline-offset:2px}
    svg{display:block;flex:none}
    .dot{flex:none;display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--c-l3)}
    .lbl{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--c-mute);font-weight:600}

    .bar{position:sticky;top:0;z-index:2;background:var(--c-bg1);border-bottom:1px solid var(--c-l1);display:flex;flex-wrap:wrap;align-items:center;gap:6px 24px;min-height:60px;padding:0 20px}
    .brand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:16px;letter-spacing:.01em;white-space:nowrap;color:var(--c-fgs)}
    .brand b{color:var(--c-acc);font-weight:700}
    .brand svg{color:var(--c-acc)}
    .home{display:flex;align-items:center;gap:9px;color:inherit;text-decoration:none;border-radius:6px}
    .home:hover b{text-decoration:underline}
    .ver{font-size:11px;font-weight:500;color:var(--c-mute);text-decoration:none;padding:2px 8px;border-radius:999px;border:1px solid var(--c-l2)}
    .ver:hover{color:var(--c-fg);border-color:var(--c-l3)}
    .ver.stale{color:var(--c-amb);border-color:var(--c-ambbd);background:var(--c-ambbg)}
    .nav{display:flex;gap:20px;align-self:stretch}
    .nav .tab{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:7px;min-height:58px;padding:0 2px;font-size:14px;font-weight:500;color:var(--c-mute);border-bottom:2px solid transparent}
    .nav .tab:hover{color:var(--c-fg)}
    .nav .tab.on{color:var(--c-fgs);border-bottom-color:var(--c-acc)}
    .count{font-size:11.5px;line-height:18px;padding:0 7px;border-radius:999px;background:var(--c-bg4);color:var(--c-fg2);font-weight:500}
    .info{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 220px;padding:6px 0}
    .status{color:var(--c-mute);font-size:12.5px;min-width:0;display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px}
    .status .stxt{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .status .signin{flex:none}
    .status .dot{background:var(--c-ok);box-shadow:0 0 0 3px rgba(92,194,140,.2)}
    .status .dot.err{background:var(--c-sev);box-shadow:0 0 0 3px rgba(239,107,99,.2)}
    .me{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--c-mute);white-space:nowrap;cursor:help}
    .me.ok .dot{background:var(--c-acc)}
    .me.warn{color:var(--c-amb)}
    .me.warn .dot{background:var(--c-amb)}
    .controls{display:flex;align-items:center;gap:8px;margin-left:auto;flex:0 1 420px;min-width:0;padding:8px 0}
    .search{display:flex;align-items:center;gap:8px;background:var(--c-bg0);border:1px solid var(--c-l2);border-radius:8px;height:36px;padding:0 10px;flex:1 1 180px;min-width:0}
    .search:focus-within{border-color:var(--c-acc)}
    .search svg{color:var(--c-mute)}
    .search input{all:unset;flex:1;min-width:0;height:34px;color:var(--c-fg);font-size:13.5px}
    .search input::placeholder{color:var(--c-mute3)}
    .btn{all:unset;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 13px;border-radius:8px;border:1px solid var(--c-l2);background:var(--c-bg3);color:var(--c-fg);font-size:13px;font-weight:500;white-space:nowrap}
    .btn:hover{background:var(--c-bg4)}
    .btn.primary{background:var(--c-acc);border-color:var(--c-acc);color:var(--c-accfg);font-weight:600;height:36px}
    .btn.primary:hover{filter:brightness(1.08)}
    .btn.icon{width:36px;height:36px;padding:0;color:var(--c-fg2)}
    .btn.icon.on{background:var(--c-bg4);border-color:var(--c-acc);color:var(--c-fgs)}
    .btn.danger{background:transparent;border-color:var(--c-sevbd);color:var(--c-sev)}
    .btn.danger:hover{background:var(--c-sevbg)}
    .btn.armed,.btn.armed:hover{background:#9a332e;border-color:#9a332e;color:#fff}
    .mini{all:unset;cursor:pointer;font-size:11.5px;line-height:22px;height:22px;padding:0 9px;border-radius:6px;border:1px solid var(--c-l2);color:var(--c-fg2);white-space:nowrap}
    a.mini{display:inline-block;text-decoration:none}
    .mini:hover{background:var(--c-bg4);color:var(--c-fgs)}
    .banner{background:#7a2824;color:#fff;padding:10px 20px;font-size:13px;border-bottom:1px solid #8a2f2b}
    .banner a{color:#fff;font-weight:700;text-decoration:underline}
    .news{margin:16px 20px 0;padding:14px 18px;border-radius:12px;background:var(--c-bg1);border:1px solid var(--c-acc);display:grid;gap:6px;font-size:13px}
    .news b{color:var(--c-fgs);font-size:14px}
    .news ul{padding-left:18px;color:var(--c-fg2);display:grid;gap:3px}
    .news .btn{justify-self:start;margin-top:6px}

    .list{display:grid;grid-template-columns:repeat(auto-fill,minmax(480px,1fr));gap:10px;align-content:start;padding:20px 20px 48px}
    .list.hist{display:block}
    @media (max-width:600px){.list{grid-template-columns:1fr;padding:14px 12px 40px}}
    .grid{grid-column:1/-1}
    .section{grid-column:1/-1;display:flex;align-items:baseline;gap:8px;color:var(--c-mute);font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;margin:6px 0 0}
    .section span{color:var(--c-fg2)}
    .section .note{margin-left:auto;text-transform:none;letter-spacing:0;font-weight:400;color:var(--c-mute)}
    .empty{grid-column:1/-1;color:var(--c-mute);padding:28px 0;font-size:13.5px}

    .recap{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:16px 36px;align-items:center;padding:18px 20px;border-radius:14px;background:var(--c-bg1);border:1px solid var(--c-l1);margin-bottom:8px}
    .recap-a{display:flex;flex-direction:column;gap:2px;min-width:150px}
    .big{font-size:28px;font-weight:700;color:var(--c-fgs);line-height:1.15}
    .sub{font-size:12.5px;color:var(--c-mute)}
    .recap-b{flex:1 1 320px;display:flex;flex-direction:column;gap:10px;min-width:0}
    .riskbar{display:flex;gap:2px;height:10px;border-radius:999px;overflow:hidden;background:var(--c-bg4)}
    .legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12.5px;color:var(--c-fg2);align-items:center}
    .legend .k{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
    .legend b{color:var(--c-fgs);font-weight:600}
    .legend .x{color:var(--c-mute);white-space:nowrap}
    .recap-c{display:flex;flex-wrap:wrap;gap:10px}
    .hl{display:flex;flex-direction:column;gap:3px;padding:10px 14px;border-radius:10px;border:1px solid var(--c-l2);background:var(--c-bg2);min-width:190px;max-width:300px}
    .hl .name{font-size:14px}
    .hl.bad{background:var(--c-sevbg);border-color:var(--c-sevbd)}
    .hl.bad .lbl{color:var(--c-sev)}
    .hl.tw{background:var(--c-twbg);border-color:var(--c-twbd)}
    .hl.tw .lbl{color:var(--c-tw)}
    .hl.good .lbl{color:var(--c-ok)}
    .hl .sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .hl .lives{color:var(--c-fg2);font-size:13px}
    .hl .lives .name{font-size:13.5px}
    .hl .more{color:var(--c-mute);cursor:help;white-space:nowrap}
    @media (max-width:700px){
      .recap{padding:14px 16px;gap:12px 24px}
      .big{font-size:22px}
      .recap-c{flex:1 1 100%;gap:6px}
      .hl{flex:1 1 100%;max-width:none;min-width:0;flex-direction:row;flex-wrap:wrap;align-items:baseline;gap:2px 8px;padding:6px 10px;border-radius:8px}
      .hl .lbl{font-size:10px}
      .hl .name{font-size:13px}
      .hl .sub{font-size:12px;flex:1 1 0;min-width:0}
      .hl.tw .sub{display:none}
    }

    .row{--ring:var(--c-l3);--gap:var(--c-bg1);display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:14px;align-items:start;padding:14px 16px;min-width:0;
      border-radius:12px;background:var(--c-bg1);border:1px solid var(--c-l1)}
    .row.clean{--ring:var(--c-ok)}
    .row.light{--ring:var(--c-lt)}
    .row.moderate{--ring:var(--c-mod)}
    .row.severe{--ring:var(--c-sev);--gap:var(--c-sevbg);background:var(--c-sevbg);border-color:var(--c-sevbd)}
    .row.pending,.row.unchecked{opacity:.75}
    .pic{width:44px;height:44px;border-radius:50%;background:var(--c-bg4);object-fit:cover;display:flex;align-items:center;justify-content:center;
      color:var(--c-fg2);font-weight:600;font-size:16px;box-shadow:0 0 0 2px var(--gap),0 0 0 4px var(--ring)}
    .main{min-width:0}
    .line{display:flex;align-items:center;gap:6px 10px;flex-wrap:wrap;min-width:0}
    .name{font-weight:600;font-size:15px;color:var(--c-fgs);text-decoration:none;overflow-wrap:anywhere}
    .name:hover{text-decoration:underline}
    .rep{display:inline-flex;align-items:center;gap:5px;min-height:22px;padding:1px 9px 1px 7px;border-radius:999px;border:1px solid var(--c-l2);font-size:12px;font-weight:500;color:var(--c-mute)}
    .row.clean .rep,.row.light .rep,.row.moderate .rep,.row.severe .rep{border-color:currentColor;font-weight:600}
    .row.clean .rep{color:var(--c-ok)}
    .row.light .rep{color:var(--c-lt)}
    .row.moderate .rep{color:var(--c-mod)}
    .row.severe .rep{color:var(--c-sev)}
    .meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;align-items:center;min-width:0}
    .tag{display:inline-flex;align-items:center;font-size:12px;line-height:22px;height:22px;padding:0 8px;border-radius:6px;background:var(--c-bg4);color:var(--c-fg2);white-space:nowrap;font-weight:500}
    .tag.amber{background:var(--c-ambbg);color:var(--c-amb)}
    .tag.green{background:var(--c-grnbg);color:var(--c-grn)}
    .tag.red{background:var(--c-redbg);color:var(--c-red)}
    .tag.live{background:#7c3aed;color:#fff;font-weight:600;text-decoration:none}
    .tag.live:hover{background:#8b5cf6}
    .tag.wasLive{text-decoration:none}
    .tag.wasLive:hover{color:var(--c-fgs)}
    .tag.met{cursor:help}
    .social{display:inline-flex;flex-wrap:wrap;gap:6px;align-items:center;min-width:0;max-width:100%}
    .soc{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px 0 3px;border-radius:6px;border:1px solid var(--c-l2);font-size:12px;color:var(--c-mute);text-decoration:none;white-space:nowrap;max-width:100%;overflow:hidden}
    a.soc{color:var(--c-fg2)}
    a.soc:hover{color:var(--c-fgs);border-color:var(--c-l3)}
    button.soc.more{all:unset;cursor:pointer;display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:6px;border:1px dashed var(--c-l3);font-size:12px;color:var(--c-acc);white-space:nowrap}
    button.soc.more:hover{border-style:solid}
    .pbadge{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 3px;border-radius:4px;font-size:9.5px;font-weight:700;letter-spacing:.02em;color:#fff;background:var(--c-l3)}
    .pbadge.twitch{background:#9146ff}
    .pbadge.discord{background:#5865f2}
    .pbadge.steam{background:#1b2838;border:1px solid #2a475e}
    .pbadge.youtube{background:#e02424}
    .pbadge.twitter,.pbadge.x{background:#000;border:1px solid #333}
    .pbadge.tiktok{background:#111;border:1px solid #333}
    .pbadge.kick{background:#53fc18;color:#111}
    .pbadge.xbox{background:#107c10}
    .pbadge.instagram{background:#c13584}
    .pbadge.reddit{background:#ff4500}
    .pbadge.bluesky{background:#1185fe}
    .side{display:flex;flex-direction:column;align-items:flex-end;gap:4px;text-align:right;font-size:12.5px;color:var(--c-mute);white-space:nowrap}
    .pres{display:inline-flex;align-items:center;gap:6px;color:var(--c-fg2)}
    .pres.sot .dot{background:var(--c-acc)}
    .pres.on .dot{background:var(--c-ok)}
    .prof{font-size:12px;color:var(--c-acc);text-decoration:none}
    .prof:hover{text-decoration:underline}
    .react-btn{margin-top:2px}
    .react{grid-column:2/-1;display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding-top:10px;border-top:1px solid var(--c-l1)}
    .row.severe .react{border-top-color:var(--c-sevbd)}
    .rchip{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 11px;border-radius:999px;border:1px solid var(--c-l2);background:var(--c-bg2);font-size:12.5px;color:var(--c-fg2)}
    .rchip:hover{border-color:var(--c-l3);color:var(--c-fgs)}
    .rchip .n{color:var(--c-mute);font-weight:600}
    .rchip.on{border-color:var(--c-acc);background:var(--c-bg4);color:var(--c-fgs)}
    .rchip.on .n{color:var(--c-acc)}
    .rchip[disabled]{opacity:.55;cursor:default}
    .react .msg{font-size:12px;color:var(--c-amb)}
    .react .note{font-size:12px;color:var(--c-mute)}
    .react .via{margin-left:auto;font-size:11.5px;color:var(--c-mute)}
    .root.compact .react{grid-column:1/-1;padding-top:6px}

    .table{border:1px solid var(--c-l1);border-radius:14px;background:var(--c-bg1);overflow-x:auto}
    .tin{min-width:880px}
    .hhead,.row.hrow{display:grid;grid-template-columns:minmax(200px,1.3fr) minmax(170px,1fr) 80px minmax(200px,1.7fr) 110px;gap:14px;align-items:center;padding:8px 18px}
    .hhead{min-height:38px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--c-mute);font-weight:600}
    .hhead :last-child,.hrow .when{text-align:right}
    .row.hrow{min-height:54px;border-radius:0;border:0;border-top:1px solid var(--c-l1);background:transparent}
    .row.hrow.severe{background:var(--c-sevbg)}
    .row.hrow{--gap:var(--c-bg1)}
    .row.hrow.severe{--gap:var(--c-sevbg)}
    .hrow .who{display:flex;align-items:center;gap:12px;min-width:0}
    .hrow .pic{width:30px;height:30px;font-size:12px;box-shadow:0 0 0 2px var(--gap),0 0 0 3.5px var(--ring)}
    .hrow .name{font-size:14px}
    .hrow .meta{margin-top:0}
    .hrow .times{font-size:13px;color:var(--c-fg2);cursor:help}
    .hrow .when{font-size:12.5px;color:var(--c-mute);white-space:nowrap}
    .tsec{display:flex;align-items:baseline;gap:8px;padding:14px 18px 8px;border-top:1px solid var(--c-l1);color:var(--c-mute);font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
    .tsec span{color:var(--c-fg2)}
    .tsec.fold{cursor:pointer;user-select:none;padding-bottom:14px}
    .tsec.fold:hover{color:var(--c-fg3)}
    .tsec .hint{margin-left:auto;text-transform:none;letter-spacing:0;color:var(--c-acc);font-size:12px;font-weight:500}

    .filters{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;padding:14px 20px;background:var(--c-bg2);border-bottom:1px solid var(--c-l1)}
    .filters .search{flex:1 1 220px;max-width:380px}
    .fchips{display:flex;flex-wrap:wrap;gap:6px}
    .fchip{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 12px;border-radius:999px;border:1px solid var(--c-l2);background:var(--c-bg3);color:var(--c-fg2);font-size:13px}
    .fchip:hover{border-color:var(--c-l3);color:var(--c-fgs)}
    .fchip.on{background:var(--c-fgs);border-color:var(--c-fgs);color:var(--c-bg0)}
    .fchip .n{opacity:.7;font-weight:600}
    .fcount{margin-left:auto;color:var(--c-mute);font-size:12.5px}
    .toggle{display:flex;align-items:center;gap:8px;color:var(--c-fg2);font-size:13px;white-space:nowrap;cursor:pointer;user-select:none}
    .toggle input,.sw{all:unset;flex:none;width:34px;height:20px;border-radius:999px;background:var(--c-l2);position:relative;transition:background .15s;cursor:pointer}
    .toggle input::after,.sw::after{content:"";position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .15s}
    .toggle input:checked,.sw:checked{background:var(--c-ok)}
    .toggle input:checked::after,.sw:checked::after{left:17px}
    .toggle input:focus-visible,.sw:focus-visible{outline:2px solid var(--c-acc);outline-offset:2px}

    .panel{display:flex;flex-wrap:wrap;gap:20px 28px;padding:24px 20px 48px;align-items:flex-start}
    .panel-head{flex:1 1 100%;display:flex;align-items:center;justify-content:space-between;gap:12px}
    .panel-head h2{font-size:20px;font-weight:700;color:var(--c-fgs)}
    .snav{flex:0 1 190px;display:flex;flex-direction:column;gap:2px}
    .snav button{all:unset;cursor:pointer;padding:8px 12px;border-radius:8px;font-size:13.5px;color:var(--c-fg2)}
    .snav button:hover{background:var(--c-bg4);color:var(--c-fgs)}
    @media (max-width:720px){.snav{display:none}}
    .cards{flex:999 1 600px;min-width:0;display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}
    .col{flex:1 1 420px;min-width:0;display:flex;flex-direction:column;gap:16px}
    @media (max-width:600px){.col{flex-basis:100%}}
    .card{background:var(--c-bg1);border:1px solid var(--c-l1);border-radius:14px;padding:18px 20px;display:flex;flex-direction:column;gap:12px;min-width:0;scroll-margin-top:80px}
    .card h3{font-size:15px;font-weight:600;color:var(--c-fgs)}
    .hint{font-size:12.5px;color:var(--c-mute);line-height:1.5}
    .card h3 + .hint{margin-top:-8px}
    .opt{display:flex;align-items:center;gap:8px 12px;padding:11px 14px;border-radius:10px;border:1px solid var(--c-l1);background:var(--c-bg2);flex-wrap:wrap}
    label.opt{cursor:pointer}
    .opt .txt{flex:1 1 180px;min-width:0;display:flex;flex-direction:column}
    .opt .t{font-size:13.5px;font-weight:500;color:var(--c-fgs)}
    .opt .s{font-size:12px;color:var(--c-mute)}
    .opt .end{display:flex;align-items:center;gap:8px;margin-left:auto}
    .opt .dot{width:12px;height:12px}
    .opt .ico{color:var(--c-fg2)}
    .opt .full{flex:1 1 100%;display:flex;gap:8px;flex-wrap:wrap}
    .field{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .input{all:unset;flex:1 1 180px;min-width:0;height:34px;padding:0 12px;border-radius:8px;border:1px solid var(--c-l2);background:var(--c-bg0);color:var(--c-fg);font-size:13px}
    .input:focus{border-color:var(--c-acc)}
    .input::placeholder{color:var(--c-mute3)}
    .msg{font-size:12.5px;color:var(--c-mute)}
    .msg:empty{display:none}
    .setrow{display:flex;align-items:center;justify-content:space-between;gap:10px 12px;flex-wrap:wrap;font-size:13.5px}
    .setrow .hint{display:block;font-size:12px}
    .seg{display:inline-flex;padding:3px;border-radius:10px;background:var(--c-bg2);border:1px solid var(--c-l1)}
    .seg .tab{all:unset;cursor:pointer;padding:6px 13px;border-radius:7px;font-size:13px;color:var(--c-fg2)}
    .seg .tab:hover{color:var(--c-fgs)}
    .seg .tab.on{background:var(--c-bg4);color:var(--c-fgs);font-weight:600}
    .dzone{border-top:1px solid var(--c-l1);padding-top:14px;display:flex;flex-direction:column;gap:10px}
    .dzone .lbl{color:var(--c-sev)}
    .dzone .setrow .hint{flex:1 1 220px;font-size:12.5px}

    .root.compact .list{padding:10px 12px 28px;gap:6px;grid-template-columns:repeat(auto-fill,minmax(380px,1fr))}
    @media (max-width:600px){.root.compact .list{grid-template-columns:1fr}}
    .root.compact .row{padding:8px 10px;gap:10px;grid-template-columns:30px minmax(0,1fr) auto}
    .root.compact .pic{width:30px;height:30px;font-size:13px;box-shadow:0 0 0 2px var(--gap),0 0 0 3.5px var(--ring)}
    .root.compact .name{font-size:13.5px}
    .root.compact .meta{margin-top:4px}
    .root.compact .side{gap:2px}
    .root.compact .row.hrow{min-height:40px;padding:4px 18px;grid-template-columns:minmax(200px,1.3fr) minmax(170px,1fr) 80px minmax(200px,1.7fr) 110px}
    .root.compact .hrow .pic{width:24px;height:24px;font-size:11px}
    .root.compact .hrow .meta{margin-top:0}
    .root.compact .recap{padding:12px 16px;margin-bottom:4px}
    .root.compact .big{font-size:22px}
    /* many controls reset their styles with all:unset, which also drops the focus ring; this puts it back for all of them */
    .root :is(button,a,input,[tabindex]):focus-visible{outline:2px solid var(--c-acc)!important;outline-offset:2px}
  `;

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }

  // Line icons, drawn in the current text colour. Fixed strings only, never anything from a player.
  const ICONS = {
    shield: '<path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    severe: '<path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z"/><path d="M12 8v5M12 16.5v.5"/>',
    moderate: '<path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17.5v.5"/>',
    light: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.5"/>',
    clean: '<path d="M5 12.5l4.5 4.5L19 7"/>',
    sound: '<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    screen: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  };
  const icon = (name, size = 16, sw = 2) => h('span', { class: 'ico', style: 'display:inline-flex', 'aria-hidden': 'true',
    html: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>` });

  // A button that must be pressed twice: first press arms it (label changes, turns red) for 4 s, second press fires.
  function twoPress(label, armedLabel, cls, action, title) {
    let armed = null;
    const btn = h('button', { class: cls, title }, label);
    const disarm = () => { armed = null; btn.textContent = label; btn.classList.remove('armed'); };
    btn.addEventListener('click', () => {
      if (armed) { clearTimeout(armed); disarm(); action(); return; }
      btn.textContent = armedLabel; btn.classList.add('armed');
      armed = setTimeout(disarm, 4000);
    });
    return btn;
  }

  // ---------- version check ----------
  // Compares this copy's @version with the one on GitHub. A pasted or stale copy gets a banner with the install link,
  // which is the nearest thing to blocking local copies. Checked on load and every 6 hours.
  // Version checks read the tiny header-only meta file (not counted); installs and updates go through the
  // latest GitHub release, which GitHub counts, so release download numbers approximate active users.
  const META_URL = 'https://raw.githubusercontent.com/MrNickIE/sotrep-live/main/sotrep-live.meta.js';
  const RAW_URL = 'https://github.com/MrNickIE/sotrep-live/releases/latest/download/sotrep-live.user.js';
  const HOME_URL = 'https://github.com/MrNickIE/sotrep-live';
  const MY_VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '0';
  function cmpVersion(a, b) {
    const pa = String(a).split('.').map(n => parseInt(n, 10) || 0), pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
    return 0;
  }
  function checkForUpdate() {
    GM_xmlhttpRequest({
      method: 'GET', url: META_URL + '?t=' + Date.now(), timeout: 15000,
      onload: (r) => {
        const m = (r.responseText || '').match(/@version\s+(\S+)/);
        if (!m) return;
        const latest = m[1];
        const installedFromLink = !!(GM_info && GM_info.scriptUpdateURL);
        if (cmpVersion(latest, MY_VERSION) > 0) {
          showUpdateBanner(latest, installedFromLink);
          if (versionEl) { versionEl.textContent = `v${MY_VERSION} · ${latest} available`; versionEl.classList.add('stale'); }
        } else if (!installedFromLink) {
          showUpdateBanner(null, false);
        } else if (versionEl) {
          versionEl.title = 'Up to date. Click to reinstall through Tampermonkey.';
        }
      },
    });
  }
  // After the install link is clicked, Tampermonkey's install page takes over (a new tab, or a popup window).
  // Once we have actually lost it and then got it back, the update has (probably) been applied, so reload to start
  // running the new version. No timer: a quick install and return must still reload. A cancelled dialog just
  // reloads harmlessly.
  let updateArmed = false, updateLeft = false;
  function armReloadOnReturn() {
    updateArmed = true; updateLeft = false;
    setStatus('Update opened in a new tab. This board reloads itself when you come back.', false);
  }
  const noteLeft = () => { if (updateArmed && (document.visibilityState === 'hidden' || !document.hasFocus())) updateLeft = true; };
  const maybeReload = () => {
    if (updateArmed && updateLeft && document.visibilityState === 'visible') {
      updateArmed = updateLeft = false;
      setTimeout(() => location.reload(), 800);
    }
  };
  window.addEventListener('blur', noteLeft);
  window.addEventListener('focus', maybeReload);
  document.addEventListener('visibilitychange', () => { noteLeft(); maybeReload(); });

  let bannerEl = null;
  function showUpdateBanner(latest, installedFromLink) {
    if (!bannerEl) return;
    bannerEl.replaceChildren(
      latest
        ? h('span', {}, `Version ${latest} is out, you are on ${MY_VERSION}. `)
        : h('span', {}, 'This copy was pasted in by hand so it will never update. '),
      h('a', { href: RAW_URL, target: '_blank', rel: 'noopener', onclick: armReloadOnReturn }, latest && installedFromLink ? 'Update now' : 'Install from the link instead'),
      latest && installedFromLink ? h('span', {}, ' (or Tampermonkey menu, Check for userscript updates)') : h('span', {}, ', then delete this copy in Tampermonkey.'),
    );
    bannerEl.style.display = '';
  }

  // ---------- your own Xbox presence ----------
  // Rare's Recently Met list stops growing while you appear offline on Xbox, so show how Xbox sees you.
  // Who you are comes from Rare's own page ("r-gtg"), your Xbox ID from one cached sotrep search, and your
  // presence from sotrep's small xbl-info reply. All with your own logins; nothing is sent anywhere else.
  const ME_VISIBLE_MS = 5 * 60e3, ME_HIDDEN_MS = 15 * 60e3;
  let meEl = null, meTimer = null, meLastCheck = 0;
  function myGamertag() {
    for (const s of document.querySelectorAll('script:not([src])')) {
      const m = s.textContent.match(/"r-gtg"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
    }
    return null;
  }
  function sotrepGet(path) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET', url: SOTREP + path, headers: { Accept: 'application/json' }, timeout: 15000,
        onload: (r) => { if (r.status !== 200) return resolve(null); try { resolve(JSON.parse(r.responseText)); } catch (e) { resolve(null); } },
        onerror: () => resolve(null), ontimeout: () => resolve(null),
      });
    });
  }
  async function resolveMe() {
    const gt = myGamertag();
    if (!gt) return null;
    if (state.me && state.me.gt === gt && state.me.xuid) return state.me;
    if (session.pauseUntil && Date.now() < session.pauseUntil) return null;   // sotrep asked us to wait
    if (session.sotrepSignedOut) return null;                                  // not signed in there
    const rep = await sotrepSearchAs(gt, 'xbox');
    if (rep.error || !rep.xuid) return null;
    state.me = { gt, xuid: String(rep.xuid) };
    save(['me']);
    return state.me;
  }
  async function checkMe() {
    clearTimeout(meTimer);
    meLastCheck = Date.now();
    try {
      const me = await resolveMe();
      const paused = (session.pauseUntil && Date.now() < session.pauseUntil) || session.sotrepSignedOut;
      const x = me && !paused ? await sotrepGet(`/api/player/${encodeURIComponent(me.xuid)}/xbl-info`) : null;
      meOfflineChecks = saysOffline(x) ? meOfflineChecks + 1 : 0;
      notePlaying(x);
      showMe(x);
    } catch (e) {
      showMe(null);
    } finally {
      meTimer = setTimeout(checkMe, document.hidden ? ME_HIDDEN_MS : ME_VISIBLE_MS);
    }
  }
  // back on the tab after a long gap: refresh straight away rather than waiting out the hidden-tab timer
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - meLastCheck > ME_VISIBLE_MS) checkMe(); });
  // sotrep sees your presence as a stranger would, and a few minutes late: just after you come online, or with Xbox
  // privacy set so only friends can see you, it says "offline" or nothing while you play. So it must say offline on
  // two checks in a row before we warn, which rides out the start-up lag, and no status at all is not a warning.
  const OFFLINE_CHECKS_TO_WARN = 2;
  let meOfflineChecks = 0;
  const saysOffline = (x) => !!x && !x.is_playing && /offline|last seen/i.test(String(x.presence_text || ''));
  // Keeps the current sitting up to date from your Xbox status (see sessionOf). No status at all says nothing.
  let meNotPlayingAt = 0;   // the latest reading that said you were not playing, while no sitting is open
  function notePlaying(x) {
    if (!x) return;
    const now = Date.now(), iso = new Date(now).toISOString();
    const sp = playSpan();
    if (x.is_playing) {
      if (spanPlaying(sp)) { state.play.last = iso; state.play.offs = 0; save(['play']); return; }
      // a new sitting. The board saw it begin if a reading said you were not playing shortly before.
      const offAt = Math.max(meNotPlayingAt, sp && Date.parse(state.play.offAt) || 0);
      const seen = offAt > 0 && now - offAt <= PLAY_END_MS;
      state.play = { start: iso, last: iso, seenStart: seen, from: seen ? new Date(offAt).toISOString() : null, offs: 0 };
      meNotPlayingAt = 0;
      save(['play']);
      if (seen && listEl) restoreRecent();   // a new sitting with the tab open: the board starts afresh as well
      if (listEl) render();
    } else if (String(x.presence_text || '').trim()) {
      meNotPlayingAt = now;
      if (sp) { state.play.offs = (state.play.offs | 0) + 1; state.play.offAt = iso; save(['play']); if (listEl) render(); }
    }
  }
  function showMe(x) {
    if (!meEl) return;
    if (!x) { meEl.style.display = 'none'; return; }
    const txt = String(x.presence_text || '').trim();
    const said = txt ? `Xbox Live told sotrep.com: "${txt}".` : 'Xbox Live gave sotrep.com no status for you.';
    const privacy = 'Xbox can take a few minutes to notice you have come online. If it never does while you play, your Xbox privacy setting is probably hiding your status from people who are not your friends (Xbox app, Settings, Privacy, "Others can see if you\'re online"). That only affects this pill.';
    let cls, label, tip;
    if (x.is_playing) {
      cls = 'ok'; label = 'You: playing SoT on Xbox'; tip = txt || 'Xbox Live sees you in Sea of Thieves.';
    } else if (!txt) {
      cls = ''; label = 'Xbox status hidden';
      tip = `${said} ${privacy} If you are set to appear offline, Rare's Recently Met list stops updating and this board will not see new players.`;
    } else if (saysOffline(x) && meOfflineChecks < OFFLINE_CHECKS_TO_WARN) {
      cls = ''; label = 'Xbox: not seen yet';
      tip = `${said} ${privacy} If it still says offline at the next check, this turns into a warning.`;
    } else if (saysOffline(x)) {
      cls = 'warn'; label = 'Xbox shows you offline';
      tip = `${said} If you are sailing while set to appear offline, Rare's Recently Met list does not update and this board will not see new players. Set yourself to online in the Xbox app. ${privacy}`;
    } else {
      cls = ''; label = 'Xbox: ' + (txt.length > 28 ? txt.slice(0, 28) + '…' : txt); tip = txt;
    }
    meEl.className = 'me ' + cls;
    meEl.replaceChildren(h('span', { class: 'dot' }), label);
    meEl.title = tip + (x.last_played_text ? `  Last played SoT ${x.last_played_text}.` : '');
    meEl.style.display = '';
  }

  // ---------- alerts ----------
  let audioCtx = null;
  function ensureAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) {}
  }
  // Two-note chime, red gets a lower, longer second note so you can tell them apart by ear
  function playChime(severity) {
    ensureAudio();
    if (!audioCtx) return;
    const notes = severity === 'severe' ? [[880, 0, 0.18], [440, 0.2, 0.45]] : [[660, 0, 0.15], [880, 0.17, 0.25]];
    for (const [freq, at, dur] of notes) {
      const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      const t = audioCtx.currentTime + at;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + dur + 0.05);
    }
  }
  function postDiscord(gt, rep, severity, link) {
    const url = (state.alerts.discord || '').trim();
    if (!/^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\//.test(url)) return Promise.resolve({ error: 'Webhook URL does not look like a Discord webhook' });
    const tags = [...(rep.manual_tags || []), ...(rep.badges || [])].map(tagName).join(', ');
    const embed = {
      title: gt,
      url: link,
      description: repLabel(rep),
      color: severity === 'severe' ? 0xd6453d : 0xe07b2a,
      fields: [
        tags ? { name: 'Tags', value: tags, inline: true } : null,
        rep.pc_check_status ? { name: 'PC check', value: String(rep.pc_check_status), inline: true } : null,
        (rep.account_count | 0) > 1 ? { name: 'Accounts', value: String(rep.account_count), inline: true } : null,
      ].filter(Boolean),
      footer: { text: 'SOTREP Live' },
      timestamp: new Date().toISOString(),
    };
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST', url, headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ username: 'SOTREP Live', embeds: [embed] }), timeout: 15000,
        onload: (r) => resolve(r.status >= 200 && r.status < 300 ? { ok: true } : { error: `Discord replied ${r.status}` }),
        onerror: () => resolve({ error: 'Could not reach Discord' }),
        ontimeout: () => resolve({ error: 'Discord timed out' }),
      });
    });
  }
  function desktopNotify(gt, rep) {
    try {
      if (window.Notification && Notification.permission === 'granted') {
        new Notification(`SOTREP: ${gt}`, { body: repLabel(rep), tag: 'sotrep-' + gt });
      } else {
        GM_notification({ title: `SOTREP: ${gt}`, text: repLabel(rep), timeout: 8000, onclick: () => window.focus() });
      }
    } catch (e) {}
  }
  // ---------- Twitch live check ----------
  // Twitch's channel page carries a JSON-LD block with "isLiveBroadcast": true while the channel is live.
  // No API key needed; one page fetch per streamer per LIVE_TTL_MS.
  function twitchLogin(rep) {
    const s = (rep && rep.socials || []).find(x => x && !x.hidden && x.platform === 'twitch' && x.username);
    if (!s) return null;
    const fromLink = s.link && (String(s.link).match(/twitch\.tv\/([A-Za-z0-9_]+)/) || [])[1];
    return (fromLink || String(s.username).trim().replace(/^@/, '')).toLowerCase();
  }
  function fetchTwitchLive(login) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET', url: `https://www.twitch.tv/${encodeURIComponent(login)}`, timeout: 20000,
        headers: { 'Accept': 'text/html' },
        onload: (r) => {
          const html = r.responseText || '';
          // the JSON-LD is embedded inside a JS string, so the quotes arrive backslash-escaped
          const live = /\\?"isLiveBroadcast\\?"\s*:\s*true/.test(html);
          let title = '';
          const m = html.match(/<meta\s+(?:name|property)="(?:og:)?description"\s+content="([^"]{0,200})"/i);
          if (m) title = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
          // a non-200 page (rate limit, outage) says nothing about whether they are live
          if (r.status !== 200) { resolve({ live: false, error: `HTTP ${r.status}`, status: r.status }); return; }
          resolve({ live, title, status: r.status });
        },
        onerror: () => resolve({ live: false, error: 'unreachable' }),
        ontimeout: () => resolve({ live: false, error: 'timeout' }),
      });
    });
  }
  function liveEntry(login) { return login ? session.live.get(login) : null; }
  function liveFresh(login) { const e = liveEntry(login); return e && (Date.now() - e.at) < LIVE_TTL_MS; }
  function queueLiveCheck(gt, login) {
    if (!login || liveFresh(login)) return;
    if (!session.liveQueue.some(q => q.login === login)) session.liveQueue.push({ gt, login });
    pumpLive();
  }
  async function pumpLive() {
    if (session.liveBusy) return;
    session.liveBusy = true;
    while (session.liveQueue.length) {
      const { gt, login } = session.liveQueue.shift();
      const prev = liveEntry(login);
      const r = await fetchTwitchLive(login);
      const url = `https://www.twitch.tv/${login}`;
      let nowLive = r.live;
      if (r.error) {
        // a failed check changes nothing: keep what we knew and just bump the time so it retries next cycle
        session.live.set(login, prev ? { ...prev, at: Date.now() } : { at: Date.now(), live: false, title: '', url, error: r.error });
        nowLive = false;
      } else if (r.live) {
        session.live.set(login, { at: Date.now(), live: true, title: r.title || '', url, misses: 0, wasLiveAt: Date.now() });
      } else if (prev && prev.live && (prev.misses | 0) < 1) {
        // first clean "not live" after LIVE: hold the pill, only a second one in a row clears it
        session.live.set(login, { ...prev, at: Date.now(), misses: (prev.misses | 0) + 1 });
      } else {
        session.live.set(login, { at: Date.now(), live: false, title: '', url, misses: 0, wasLiveAt: prev && prev.wasLiveAt });
      }
      // Twitch can lag a stream that has just started, and a first answer of "not live" would otherwise stand for
      // five minutes. So a streamer's first check this session that is not live gets one quick second look.
      if (!prev && !r.live) session.live.get(login).at = Date.now() - LIVE_TTL_MS + LIVE_FIRST_RECHECK_MS;
      if (nowLive && gt) { state.lives[gt] = new Date().toISOString(); save(['lives']); }   // so the session card can say who was live
      render();
      // alert on the transition to live (or the first time we see them live), not on every re-check
      if (r.live && !(prev && prev.live) && session.order.includes(gt) && !session.manual.has(gt)) fireStreamerAlert(gt, login, r.title);
      await new Promise(res => setTimeout(res, LIVE_GAP_MS));
    }
    session.liveBusy = false;
  }
  async function fireStreamerAlert(gt, login, title) {
    if (!state.alerts.streamers) return;
    const url = `https://www.twitch.tv/${login}`;
    if (state.alerts.sound) playChime('moderate');
    if (state.alerts.desktop) { try { GM_notification({ title: `Streamer live: ${gt}`, text: title || url, timeout: 8000, onclick: () => window.open(url) }); } catch (e) {} }
    if (state.alerts.discord) {
      const r = await postDiscordRaw({
        title: `${gt} is live on Twitch`, url, description: title || '', color: 0x9146ff,
        footer: { text: 'SOTREP Live' }, timestamp: new Date().toISOString(),
      });
      if (r.error) setStatus('Discord alert failed: ' + r.error, true);
    }
  }
  function postDiscordRaw(embed) {
    const url = (state.alerts.discord || '').trim();
    if (!/^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\//.test(url)) return Promise.resolve({ error: 'Webhook URL does not look like a Discord webhook' });
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST', url, headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ username: 'SOTREP Live', embeds: [embed] }), timeout: 15000,
        onload: (r) => resolve(r.status >= 200 && r.status < 300 ? { ok: true } : { error: `Discord replied ${r.status}` }),
        onerror: () => resolve({ error: 'Could not reach Discord' }),
        ontimeout: () => resolve({ error: 'Discord timed out' }),
      });
    });
  }

  function meetsThreshold(cls) {
    return (cls === 'severe' && state.alerts.severe) || (cls === 'moderate' && state.alerts.moderate);
  }
  async function fireAlerts(gt, rep) {
    const cls = repClass(rep);
    if (!meetsThreshold(cls)) return;
    const link = rep.profile_id ? `${SOTREP}/search/${rep.profile_id}` : `${SOTREP}/`;
    if (state.alerts.sound) playChime(cls);
    if (state.alerts.desktop) desktopNotify(gt, rep);
    if (state.alerts.discord) {
      const r = await postDiscord(gt, rep, cls, link);
      if (r.error) setStatus('Discord alert failed: ' + r.error, true);
    }
  }

  let setSettings, listEl, statusEl, nameBox, panelEl, versionEl, rootEl, filterEl, filterCount, newsEl;
  function setView(v) { session.setView(v); }

  // ---------- display: theme and layout ----------
  const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function applyDisplay() {
    if (!rootEl) return;
    const light = state.ui.theme === 'light' || (state.ui.theme === 'auto' && !!darkQuery && !darkQuery.matches);
    rootEl.classList.toggle('light', light);
    rootEl.classList.toggle('compact', state.ui.layout === 'compact');
  }
  if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', applyDisplay);
  // a row of buttons where one is on; .pick(value) sets it from code
  function segmented(options, current, onPick) {
    const wrap = h('div', { class: 'seg' });
    const btns = options.map(([v, label]) => h('button', { class: 'tab' + (v === current ? ' on' : ''), 'data-v': v }, label));
    wrap.pick = (v) => btns.forEach(b => b.classList.toggle('on', b.getAttribute('data-v') === v));
    btns.forEach(b => b.addEventListener('click', () => { wrap.pick(b.getAttribute('data-v')); onPick(b.getAttribute('data-v')); }));
    wrap.append(...btns);
    return wrap;
  }

  // ---------- backup: export and import ----------
  // Everything lives in Tampermonkey's storage in this browser. A backup file is the only copy anywhere else.
  // The Discord webhook is a posting credential, so it is never written to the file and an import never touches it.
  const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const okKey = (k) => typeof k === 'string' && k.length > 0 && k.length <= 64 && !BAD_KEYS.has(k);
  const okIso = (t) => typeof t === 'string' && t.length <= 40 && !isNaN(Date.parse(t));
  const plain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
  function exportBackup() {
    const data = {
      format: 'sotrep-live-backup', version: 1, script: MY_VERSION, exported: new Date().toISOString(),
      seen: state.seen, cache: state.cache, meets: state.meets, baselined: state.baselined, baselineAt: state.baselineAt,
      inList: state.inList, missing: state.missing, alerts: Object.assign({}, state.alerts, { discord: '' }), ui: state.ui,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    const a = h('a', { href: url, download: `sotrep-live-backup-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return `Saved ${Object.keys(state.seen).length} players`;
  }
  // a cached sotrep reply from a file: keep the shape, but only plain https pictures and safe profile ids
  function cleanRep(rep) {
    if (!plain(rep)) return null;
    const r = JSON.parse(JSON.stringify(rep));
    if ('gamerpic_url' in r && !/^https:\/\//i.test(String(r.gamerpic_url || ''))) delete r.gamerpic_url;
    if ('profile_id' in r && !/^[\w-]{1,64}$/.test(String(r.profile_id))) delete r.profile_id;
    return r;
  }
  // Merges a backup into what is here: new players are added and, on a clash, the newer entry wins.
  function importBackup(text) {
    let d;
    try { d = JSON.parse(text); } catch (e) { return { error: 'That is not a SOTREP Live backup (not a valid file).' }; }
    if (!plain(d) || d.format !== 'sotrep-live-backup' || !plain(d.seen)) return { error: 'That is not a SOTREP Live backup.' };
    const impBase = okIso(d.baselineAt) ? d.baselineAt : null;
    if (!state.baselined && d.baselined === true && impBase) {
      state.baselined = true; state.baselineAt = impBase;
      state.inList = plain(d.inList) ? Object.fromEntries(Object.keys(d.inList).filter(okKey).map(k => [k, true])) : null;
      state.missing = plain(d.missing) ? Object.fromEntries(Object.entries(d.missing).filter(([k, v]) => okKey(k) && Number.isFinite(v)).map(([k, v]) => [k, v | 0])) : {};
    }
    let added = 0, updated = 0;
    for (const [gt, raw] of Object.entries(d.seen)) {
      if (!okKey(gt) || !okIso(raw)) continue;
      const iso = impBase && raw === impBase && state.baselineAt ? state.baselineAt : raw;
      const cur = state.seen[gt];
      if (!cur) { state.seen[gt] = iso; added++; }
      else if (Date.parse(iso) > Date.parse(cur)) { state.seen[gt] = iso; updated++; }
    }
    if (plain(d.cache)) {
      for (const [gt, e] of Object.entries(d.cache)) {
        if (!okKey(gt) || !plain(e) || !Number.isFinite(e.at)) continue;
        const rp = cleanRep(e.rep);
        if (!rp) continue;
        const cur = state.cache[gt];
        if (!cur || cur.at < e.at) state.cache[gt] = { at: e.at, rep: rp, rechecks: Math.min(e.rechecks | 0, 5), picRetried: !!e.picRetried, ...(e.trimmed === true ? { trimmed: true } : {}) };
      }
    }
    if (plain(d.meets)) {
      const cutoff = Date.now() - 30 * 864e5;
      for (const [gt, arr] of Object.entries(d.meets)) {
        if (!okKey(gt) || !Array.isArray(arr)) continue;
        const all = [...new Set([...(state.meets[gt] || []), ...arr.filter(okIso)])].filter(t => Date.parse(t) >= cutoff).sort();
        if (all.length) state.meets[gt] = all.slice(-30);
      }
    }
    if (plain(d.alerts)) for (const k of ['sound', 'desktop', 'severe', 'moderate', 'streamers']) if (typeof d.alerts[k] === 'boolean') state.alerts[k] = d.alerts[k];
    if (plain(d.ui)) {
      if (['dark', 'light', 'auto'].includes(d.ui.theme)) state.ui.theme = d.ui.theme;
      if (['comfortable', 'compact'].includes(d.ui.layout)) state.ui.layout = d.ui.layout;
      if (typeof d.ui.pinRed === 'boolean') state.ui.pinRed = d.ui.pinRed;
    }
    save();
    restoreRecent();
    return { added, updated };
  }

  // ---------- what's new ----------
  // One short list per release, shown once after an update. A fresh install sees nothing: it has nothing to compare to.
  const WHATS_NEW = {
    '2.1.0': [
      'Sessions follow when you actually play. The board reads your Xbox status (the same check as before, no extra requests), so the session card says "Playing since" and two sittings in one evening stay apart. If Xbox hides your status, it falls back to the old rule: a gap of over 90 minutes between meetings.',
      'Red players stay pinned at the top of Recent for the whole session, under Watch out. Turn it off in Settings, Display.',
      'If sotrep.com asks for a captcha while you react, the board says so and offers Open sotrep.com, just like lookups.',
    ],
    '2.0.2': [
      'Reacting is safer: your reactions are read from sotrep.com every time you open React, and the buttons only appear once they are known, so a click can never undo a reaction you left elsewhere.',
      'Reactions on different cards are spaced out properly, and nothing is sent while sotrep.com has asked us to wait.',
      'Two different accounts with the same name are no longer merged, and a History search always shows the social it matched.',
    ],
    '2.0.1': [
      'Players with a long list of socials no longer take over the board. Repeats are merged, Twitch comes first, and only a few show until you press +N more on that card.',
    ],
    '2.0.0': [
      'A fresh look. The session card shows your red, orange, yellow and clean split as a bar, with who to watch out for and who is live on Twitch.',
      'Every player has a reputation badge with its own shape (octagon red, triangle orange, circle yellow, tick clean), so the colours are easy to tell apart, plus a link to their SoT Rep profile.',
      'History is now a table you can scan: reputation, times met, tags and when, grouped by day. The colour filters show how many players each one holds.',
      'React from the board: Suspicious, Skilled, Clown or Friendly, the same reactions as a sotrep.com profile, on anyone the game put on your Recent board. Press React on their card.',
      'Settings is laid out in sections with switches. Clear and Reset have moved into Settings, under Your data, so they cannot be pressed by accident.',
    ],
    '1.0.11': [
      'A streamer you have just met shows LIVE much sooner: if the first Twitch check says not live (or fails), it checks once more a minute later instead of waiting five.',
    ],
    '1.0.10': [
      'Signed out of both sites on a narrow window? Both Sign in buttons now stay visible (the status line wraps).',
      'One fewer request to sotrep.com after you sign back in there.',
    ],
    '1.0.9': [
      'A refresh now keeps your whole session on the Recent board, not just the last 20 minutes. A new session starts after 90 minutes with no new meetings.',
      'Signed out of seaofthieves.com: it also retries every 5 minutes, so a board left on a second screen recovers without a reload.',
      'The Sign in buttons can no longer be hidden on a narrow window, and signing back in to sotrep.com is picked up even when no lookups are waiting.',
    ],
    '1.0.8': [
      'The LIVE on Twitch pill no longer flickers off when Twitch hiccups. It only goes after two clear "not live" answers in a row, and a failed check changes nothing.',
      'Someone who was live earlier in the session now shows a grey "was live" time that links to their channel.',
    ],
    '1.0.7': [
      'When sotrep.com wants a captcha or a finished sign-up, the status line now has an Open sotrep.com button. Do it there, come back to this tab and lookups carry on.',
    ],
    '1.0.6': [
      'Signed out of seaofthieves.com or sotrep.com? The status line now has a Sign in button that opens the right page in a new tab. Come back to this tab and it picks up where it left off, no reload needed.',
      'While signed out it stops retrying on a timer, so it asks each site far less often than before.',
    ],
    '1.0.5': [
      'Settings is easier to close: the button says Close settings while open, the panel has a Close button, and Esc or switching tab closes it.',
    ],
    '1.0.4': [
      'The session card now says how many players are LIVE on Twitch right now, and how many were live, instead of counting everyone with a Twitch channel as a streamer.',
    ],
    '1.0.3': [
      'A row now says how many times you have met a player, and when before this.',
      'A session card on Recent sums up who you met: flags, streamers, and the worst and best of them.',
      'History has search and filters: name, colour, streamers, met more than once.',
      'Settings has a light theme, a compact layout, and backup: export everything to a file and import it back.',
    ],
  };
  function showNews() {
    if (state.lastVersion === MY_VERSION || !newsEl) return;
    const notes = WHATS_NEW[MY_VERSION];
    const done = () => { state.lastVersion = MY_VERSION; save(['lastVersion']); newsEl.style.display = 'none'; };
    if (!notes || !state.baselined) { state.lastVersion = MY_VERSION; save(['lastVersion']); return; }
    newsEl.replaceChildren(
      h('div', {}, h('b', {}, `What's new in ${MY_VERSION}`)),
      h('ul', {}, notes.map(n => h('li', {}, n))),
      h('button', { class: 'btn', onclick: done }, 'Got it'),
    );
    newsEl.style.display = '';
  }

  function buildAlertsPanel() {
    const a = state.alerts;
    // a switch row: coloured dot or icon, a title and a line under it, then any buttons and the switch itself
    const toggleRow = (key, lead, title, sub, ...extra) => {
      const c = h('input', { type: 'checkbox', class: 'sw', 'aria-label': title }); c.checked = !!a[key];
      c.addEventListener('change', () => { a[key] = c.checked; save(['alerts']); if (key === 'sound' && c.checked) ensureAudio(); });
      return h('div', { class: 'opt' }, lead, h('div', { class: 'txt' }, h('span', { class: 't' }, title), sub ? h('span', { class: 's' }, sub) : null), h('div', { class: 'end' }, ...extra, c));
    };
    const dot = (colour) => h('span', { class: 'dot', style: `background:var(${colour})` });
    const card = (id, title, hint, ...kids) => h('section', { class: 'card', id: 'set-' + id }, h('h3', {}, title), hint ? h('p', { class: 'hint' }, hint) : null, ...kids);
    // masked like a password: a webhook URL is a posting credential for that channel
    const webhook = h('input', { type: 'password', class: 'input', placeholder: 'https://discord.com/api/webhooks/…', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Discord webhook URL' });
    webhook.value = a.discord || '';
    webhook.addEventListener('change', () => { a.discord = webhook.value.trim(); save(['alerts']); });
    const showBtn = h('button', { class: 'btn' }, 'Show');
    showBtn.addEventListener('click', () => { const hidden = webhook.type === 'password'; webhook.type = hidden ? 'text' : 'password'; showBtn.textContent = hidden ? 'Hide' : 'Show'; });
    const discordMsg = h('span', { class: 'msg' });
    const discordTest = h('button', { class: 'btn' }, 'Test');
    discordTest.addEventListener('click', async () => {
      a.discord = webhook.value.trim(); save(['alerts']);
      if (!a.discord) { discordMsg.textContent = 'No webhook URL'; return; }
      discordMsg.textContent = 'Sending…';
      const r = await postDiscord('TestPirate', { severe_count: 1, banned_xuids: ['test'], manual_tags: [{ tooltip: 'Test alert' }] }, 'severe', SOTREP);
      discordMsg.textContent = r.ok ? 'Posted to Discord' : r.error;
    });
    const diagMsg = h('span', { class: 'msg' });
    const diagBtn = h('button', { class: 'btn' }, 'Run test');
    diagBtn.addEventListener('click', async () => {
      // looks up whoever is signed in on this browser, so no gamertag is written into the script
      const own = myGamertag();
      if (!own) { diagMsg.textContent = 'Could not read your gamertag from this page. Reload while signed in to seaofthieves.com.'; return; }
      diagMsg.textContent = 'Asking sotrep.com…';
      const t0 = Date.now();
      const r = await sotrepSearchAs(own, 'xbox');
      const ms = Date.now() - t0;
      diagMsg.textContent = r.error ? `${ms} ms: ${r.error}` : `${ms} ms: ok, signed in and sotrep.com answered`;
    });
    const soundTest = h('button', { class: 'btn' }, 'Test');
    soundTest.addEventListener('click', (e) => { e.preventDefault(); playChime('severe'); });
    const twBox = h('input', { type: 'text', class: 'input', placeholder: 'twitch channel name', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Twitch channel to check' });
    const twMsg = h('span', { class: 'msg' });
    const twTest = h('button', { class: 'btn' }, 'Check Twitch');
    const runTw = async () => {
      const login = twBox.value.trim().replace(/^@/, '').replace(/^.*twitch\.tv\//, '').toLowerCase();
      if (!login) return;
      twMsg.textContent = 'Checking…';
      const r = await fetchTwitchLive(login);
      twMsg.textContent = r.error ? 'Twitch: ' + r.error : (r.live ? `${login} is LIVE` : `${login} is offline`) + (r.title ? ' · ' + r.title.slice(0, 80) : '');
      if (r.live && state.alerts.streamers) fireStreamerAlert(login, login, r.title);
    };
    twTest.addEventListener('click', runTw);
    twBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') runTw(); });

    const testMsg = h('span', { class: 'msg' });
    const fakeRep = { severe_count: 1, banned_xuids: ['test'], manual_tags: [{ tooltip: 'Test alert' }], profile_id: null };
    const testAll = h('button', { class: 'btn primary' }, 'Test alerts');
    testAll.addEventListener('click', async () => {
      testMsg.textContent = 'Testing…';
      const parts = [];
      if (a.sound) { playChime('severe'); parts.push('sound played'); }
      if (a.desktop) { desktopNotify('TestPirate', fakeRep); parts.push('desktop sent'); }
      if (a.discord) { const r = await postDiscord('TestPirate', fakeRep, 'severe', SOTREP); parts.push(r.ok ? 'Discord ok' : 'Discord: ' + r.error); }
      testMsg.textContent = parts.length ? parts.join(' · ') : 'Nothing enabled';
    });
    const desktopBtn = h('button', { class: 'btn' }, 'Allow');
    desktopBtn.addEventListener('click', async () => {
      try { const p = await Notification.requestPermission(); testMsg.textContent = 'Desktop notifications: ' + p; } catch (e) { testMsg.textContent = 'Not available in this browser'; }
    });

    const themeCtl = segmented([['dark', 'Dark'], ['light', 'Light'], ['auto', 'Match device']], state.ui.theme, (v) => { state.ui.theme = v; save(['ui']); applyDisplay(); });
    const layoutCtl = segmented([['comfortable', 'Comfortable'], ['compact', 'Compact']], state.ui.layout, (v) => { state.ui.layout = v; save(['ui']); applyDisplay(); });
    const pinSw = h('input', { type: 'checkbox', class: 'sw', 'aria-label': 'Pin red players to the top of Recent' });
    pinSw.checked = state.ui.pinRed !== false;
    pinSw.addEventListener('change', () => { state.ui.pinRed = pinSw.checked; save(['ui']); render(); });
    const pinRow = h('div', { class: 'setrow' }, h('span', {}, 'Pin red players', h('span', { class: 'hint' }, 'Keep them at the top of Recent for the whole session')), pinSw);
    const backupMsg = h('span', { class: 'msg' });
    const exportBtn = h('button', { class: 'btn' }, 'Export backup');
    exportBtn.addEventListener('click', () => { backupMsg.textContent = exportBackup(); });
    const fileIn = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
    const importBtn = h('button', { class: 'btn' }, 'Import backup');
    importBtn.addEventListener('click', () => fileIn.click());
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files && fileIn.files[0];
      fileIn.value = '';
      if (!f) return;
      if (f.size > 20e6) { backupMsg.textContent = 'That file is too big to be a backup.'; return; }
      const r = importBackup(await f.text());
      if (r.error) { backupMsg.textContent = r.error; return; }
      themeCtl.pick(state.ui.theme); layoutCtl.pick(state.ui.layout); pinSw.checked = state.ui.pinRed !== false; applyDisplay();
      backupMsg.textContent = `Imported: ${r.added} new, ${r.updated} updated`;
      render();
    });
    const clearMsg = h('span', { class: 'msg' });
    const clearBtn = h('button', { class: 'btn danger', title: 'Clear the Recent board. Names stay remembered so they are not treated as new again.' }, 'Clear board');
    clearBtn.addEventListener('click', () => { clearSession(); clearMsg.textContent = 'Recent board cleared'; });
    const resetBtn = twoPress('Reset everything', 'Press again to reset', 'btn danger', () => { resetAll(); clearMsg.textContent = 'Everything reset, taking a new baseline'; }, 'Forget all remembered names and cached lookups and re-baseline. Press twice.');

    const sections = [
      card('alerts', 'Alert me when I meet', 'Any mix. Turn off the first two for a Twitch only watch. Alerts never fire for names you look up by hand.',
        toggleRow('severe', dot('--c-sev'), 'Red players', 'Severe flags or banned accounts'),
        toggleRow('moderate', dot('--c-mod'), 'Orange players', 'Moderate flags'),
        toggleRow('streamers', dot('--c-tw'), 'Streamers live now', 'A linked Twitch channel that is live. Checked when they appear and every 5 minutes on the Recent board.'),
        h('div', { class: 'field' }, twBox, twTest),
        twMsg,
        h('p', { class: 'hint' }, 'Type any Twitch channel to test the live check. A live one also fires the streamer alert.'),
      ),
      card('where', 'Where alerts go', 'The chime works with the game in front. Desktop notifications hide behind a full screen game.',
        toggleRow('sound', icon('sound', 18), 'Chime in this tab', 'No permissions needed', soundTest),
        h('div', { class: 'opt' }, icon('chat', 18),
          h('div', { class: 'txt' }, h('span', { class: 't' }, 'Discord webhook'), h('span', { class: 's' }, 'Flagged players are posted to a private channel with the rep and a profile link')),
          h('div', { class: 'full' }, webhook, showBtn, discordTest), discordMsg),
        toggleRow('desktop', icon('screen', 18), 'Desktop notification', 'Best on a second screen', desktopBtn),
        h('div', { class: 'field' }, testAll, testMsg),
      ),
      card('display', 'Display', null,
        h('div', { class: 'setrow' }, h('span', {}, 'Theme'), themeCtl),
        h('div', { class: 'setrow' }, h('span', {}, 'Layout', h('span', { class: 'hint' }, 'Compact fits more players on screen')), layoutCtl),
        pinRow,
      ),
      card('data', 'Your data', 'Everything this tool remembers (who you met, lookups, settings) lives in Tampermonkey in this browser only. Export saves it to a file you keep. Import adds a backup back in and keeps the newer entry on a clash. Your Discord webhook is never put in the file.',
        h('div', { class: 'field' }, exportBtn, importBtn, fileIn), backupMsg,
        h('div', { class: 'dzone' },
          h('span', { class: 'lbl' }, 'Danger zone'),
          h('div', { class: 'setrow' }, h('span', { class: 'hint' }, 'Empty the Recent board. Everyone stays remembered, so they are not treated as new again.'), clearBtn),
          h('div', { class: 'setrow' }, h('span', { class: 'hint' }, 'Forget everyone you have met and every lookup, then take a new baseline. Settings are kept.'), resetBtn),
          clearMsg),
      ),
      card('diag', 'Diagnostics', 'For when rows sit on "queued" or show refusals.',
        h('div', { class: 'opt' }, icon('pulse', 18), h('div', { class: 'txt' }, h('span', { class: 't' }, 'sotrep.com connection'), h('span', { class: 's' }, 'One lookup of your own gamertag, with the result and timing')), h('div', { class: 'end' }, diagBtn)),
        diagMsg,
      ),
      card('about', 'About', `SOTREP Live ${MY_VERSION}. An independent personal tool, not affiliated with or endorsed by SoT Rep, Rare or Microsoft.`,
        h('div', { class: 'field' },
          h('a', { class: 'btn', href: HOME_URL, target: '_blank', rel: 'noopener' }, 'Project page on GitHub'),
          h('a', { class: 'btn', href: HOME_URL + '/issues', target: '_blank', rel: 'noopener' }, 'Report a problem')),
      ),
    ];
    const jump = (label, id) => h('button', { onclick: () => { const el = sections.find(s => s.id === 'set-' + id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, label);
    panelEl = h('div', { class: 'panel', style: 'display:none' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Settings'), h('button', { class: 'btn', onclick: () => setSettings(false) }, icon('close', 14, 2.4), 'Close settings')),
      h('nav', { class: 'snav', 'aria-label': 'Settings sections' },
        jump('Alerts', 'alerts'), jump('Where alerts go', 'where'), jump('Display', 'display'), jump('Your data', 'data'), jump('Diagnostics', 'diag'), jump('About', 'about')),
      h('div', { class: 'cards' }, h('div', { class: 'col' }, sections[0], sections[1]), h('div', { class: 'col' }, sections[2], sections[3], sections[4], sections[5])),
    );
    return panelEl;
  }
  let tabCounts = {}, chipCounts = {};
  function buildUI() {
    const host = document.createElement('div');
    host.id = 'sotrep-live-host';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.append(h('style', { html: css }));

    statusEl = h('span', { class: 'status' }, h('span', { class: 'dot' }), 'Starting…');

    nameBox = h('input', { type: 'text', placeholder: 'Check a gamertag', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Check a gamertag' });
    nameBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') checkName(); });

    const alertsBtn = h('button', { class: 'btn icon', title: 'Settings', 'aria-label': 'Settings', 'aria-pressed': 'false' }, icon('gear', 18));
    // one way in, four ways out: the gear button, the Close settings button in the panel, Esc, or a tab.
    // Settings takes the place of the board while open.
    setSettings = (open) => {
      panelEl.style.display = open ? '' : 'none';
      listEl.style.display = open ? 'none' : '';
      filterEl.style.display = !open && session.view === 'history' ? '' : 'none';
      alertsBtn.classList.toggle('on', open);
      alertsBtn.setAttribute('aria-pressed', String(open));
      if (open) rootEl.scrollTo(0, 0);
    };
    alertsBtn.addEventListener('click', () => setSettings(panelEl.style.display === 'none'));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panelEl.style.display !== 'none') setSettings(false); });

    tabCounts = { recent: h('span', { class: 'count' }), history: h('span', { class: 'count' }) };
    const tabRecent = h('button', { class: 'tab on', onclick: () => { setSettings(false); setView('recent'); } }, 'Recent', tabCounts.recent);
    const tabHistory = h('button', { class: 'tab', onclick: () => { setSettings(false); setView('history'); } }, 'History', tabCounts.history);
    session.setView = (v) => { session.view = v; tabRecent.classList.toggle('on', v === 'recent'); tabHistory.classList.toggle('on', v === 'history'); filterEl.style.display = v === 'history' ? '' : 'none'; render(); };

    versionEl = h('a', { class: 'ver', href: RAW_URL, target: '_blank', rel: 'noopener', title: 'Click to update or reinstall through Tampermonkey', onclick: armReloadOnReturn }, 'v' + MY_VERSION);
    const bar = h('div', { class: 'bar' },
      h('div', { class: 'brand' }, h('a', { class: 'home', href: HOME_URL, target: '_blank', rel: 'noopener', title: 'SOTREP Live on GitHub' }, icon('shield', 24), h('span', {}, 'SOTREP ', h('b', {}, 'Live'))), versionEl),
      h('nav', { class: 'nav', 'aria-label': 'Views' }, tabRecent, tabHistory),
      h('div', { class: 'info' }, statusEl, (meEl = h('span', { class: 'me', style: 'display:none' }))),
      h('div', { class: 'controls' },
        h('label', { class: 'search' }, icon('search', 16), nameBox),
        h('button', { class: 'btn primary', onclick: checkName }, 'Check'),
        alertsBtn,
      ),
    );
    listEl = h('div', { class: 'list' });
    bannerEl = h('div', { class: 'banner', style: 'display:none' });
    newsEl = h('div', { class: 'news', style: 'display:none' });
    // History filters live outside the list so typing is not interrupted when the board redraws
    const histBox = h('input', { type: 'text', placeholder: 'Search name, social or tag', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Search History' });
    histBox.addEventListener('input', () => { session.hist.q = histBox.value.trim(); render(); });
    const histToggle = (label, key) => {
      const c = h('input', { type: 'checkbox' });
      c.addEventListener('change', () => { session.hist[key] = c.checked; render(); });
      return h('label', { class: 'toggle' }, c, label);
    };
    const chips = [['all', 'All', null], ['red', 'Red', '--c-sev'], ['orange', 'Orange', '--c-mod'], ['yellow', 'Yellow', '--c-lt'], ['green', 'Green', '--c-ok'], ['unchecked', 'Not checked', '--c-l3']].map(([v, label, colour]) => {
      chipCounts[v] = h('span', { class: 'n' });
      const b = h('button', { class: 'fchip' + (v === 'all' ? ' on' : ''), 'aria-pressed': String(v === 'all') },
        colour ? h('span', { class: 'dot', style: `background:var(${colour})` }) : null, label, chipCounts[v]);
      b.addEventListener('click', () => {
        session.hist.colour = v;
        for (const o of chipRow.children) { const on = o === b; o.classList.toggle('on', on); o.setAttribute('aria-pressed', String(on)); }
        render();
      });
      return b;
    });
    const chipRow = h('div', { class: 'fchips', role: 'group', 'aria-label': 'Reputation' }, chips);
    filterEl = h('div', { class: 'filters', style: 'display:none' },
      h('label', { class: 'search' }, icon('search', 16), histBox),
      chipRow,
      histToggle('Streamers', 'streamers'), histToggle('Met more than once', 'repeat'),
      (filterCount = h('span', { class: 'fcount' })),
    );
    const root = h('div', { class: 'root' }, bar, bannerEl, newsEl, buildAlertsPanel(), filterEl, listEl);
    rootEl = root;
    applyDisplay();
    // any click on the board counts as the user gesture Chrome wants before a tab may play audio
    root.addEventListener('click', ensureAudio, { once: true });
    shadow.append(root);
    document.body.append(host);
    document.title = 'SOTREP Live';
    render();
    showNews();
  }

  const fixing = () => session.pauseFix && session.pauseUntil && Date.now() < session.pauseUntil;
  const SIGNIN_LOGIN = 'https://www.seaofthieves.com/login';
  // Redraw after a sign-in flag changed outside the poll and lookup loops (which set the status themselves).
  // Signed out of seaofthieves.com keeps its own message; otherwise the normal line, which says if lookups are parked.
  let lastStatus = ['', false];
  function refreshStatus() {
    if (!statusEl) return;
    if (session.signedOut || !session.lastPoll) setStatus(...lastStatus);
    else setStatus(statusLine(), !!session.sotrepSignedOut);
  }
  function setStatus(txt, err) {
    lastStatus = [txt, err];
    // a Sign in button for each site that has said we are signed out; they open the page in a new tab
    const signin = (label, href) => h('a', { class: 'mini signin', href, target: '_blank', rel: 'noopener' }, label);
    const btns = [];
    if (session.signedOut) btns.push(signin('Sign in to seaofthieves.com', SIGNIN_LOGIN));
    if (session.sotrepSignedOut) btns.push(signin('Sign in to sotrep.com', SOTREP));
    else if (fixing()) btns.push(signin('Open sotrep.com', SOTREP));
    statusEl.replaceChildren(h('span', { class: 'dot' + (err || btns.length ? ' err' : '') }), h('span', { class: 'stxt', title: txt }, txt), ...btns);
  }
  function statusLine() {
    const t = session.lastPoll ? session.lastPoll.toLocaleTimeString('en-GB') : '…';
    const q = session.queue.length ? ` · ${session.queue.length} lookup${session.queue.length > 1 ? 's' : ''} queued` : '';
    const every = Math.round((typeof nextPollDelay === 'function' ? nextPollDelay() : POLL_SECONDS * 1000) / 1000);
    const cadence = every > POLL_SECONDS ? ` · quiet, checking every ${every >= 120 ? Math.round(every / 60) + ' min' : every + ' s'}` : '';
    const parked = session.sotrepSignedOut ? ' · lookups paused, not signed in to sotrep.com' : '';
    const fix = fixing() ? ' · lookups paused, sotrep.com needs a quick check' : '';
    return `${session.count} in Recently Met · checked ${t}${q}${cadence}${parked}${fix}`;
  }

  function repClass(rep) {
    if (!rep) return 'pending';
    if (rep.error) return '';
    if ((rep.severe_count | 0) > 0 || (rep.banned_xuids || []).length > 0) return 'severe';
    if ((rep.moderate_count | 0) > 0) return 'moderate';
    if ((rep.light_count | 0) > 0) return 'light';
    return 'clean';
  }
  function repLabel(rep) {
    if (!rep) return 'looking up…';
    if (rep.error) return rep.error;
    const parts = [];
    if ((rep.banned_xuids || []).length) parts.push(`${rep.banned_xuids.length} banned account${rep.banned_xuids.length > 1 ? 's' : ''}`);
    if (rep.severe_count) parts.push(`${rep.severe_count} severe`);
    if (rep.moderate_count) parts.push(`${rep.moderate_count} moderate`);
    if (rep.light_count) parts.push(`${rep.light_count} light`);
    if (!parts.length) return rep.reputation_override || 'Clean';
    return parts.join(' · ');
  }
  const tagName = (t) => typeof t === 'string' ? t : (t.tooltip || t.name || t.label || t.title || t.slug || 'tag');
  const PLATFORM_LETTER = { twitch: 'T', discord: 'D', steam: 'S', youtube: 'Y', twitter: 'X', x: 'X', tiktok: 'Tk', kick: 'K', xbox: 'Xb', instagram: 'Ig', reddit: 'R', bluesky: 'B' };

  // Baseline names all share the timestamp of the very first poll; anything with that stamp was met before tracking began
  function baselineStamp() {
    if (state.baselineAt) return state.baselineAt;
    const stamps = Object.values(state.seen);
    if (!stamps.length) return null;
    const counts = {};
    for (const s of stamps) counts[s] = (counts[s] | 0) + 1;
    const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return n > 20 ? best : null;   // only a big cluster counts as the baseline
  }
  function dayLabel(d) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const that = new Date(d); that.setHours(0, 0, 0, 0);
    const diff = Math.round((today - that) / 864e5);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  function render() {
    listEl.replaceChildren();
    tabCounts.recent.textContent = session.order.length;
    tabCounts.history.textContent = Object.keys(state.seen).length;
    listEl.classList.toggle('hist', session.view === 'history');
    if (session.view === 'history') return renderHistory();
    const recap = sessionRecap();
    if (recap) listEl.append(recap);
    if (!session.order.length) {
      listEl.append(h('div', { class: 'empty' }, state.baselined
        ? `Watching. ${Object.keys(state.seen).length} names remembered; new encounters appear here as the game registers them. History shows everyone seen so far.`
        : 'Taking baseline…'));
      return;
    }
    // red players stay at the top for the whole session, so they do not scroll away as you meet more people
    const red = state.ui.pinRed !== false ? session.order.filter(gt => repClass(state.cache[gt] && state.cache[gt].rep) === 'severe') : [];
    const rest = session.order.filter(gt => !red.includes(gt));
    if (red.length) {
      listEl.append(h('div', { class: 'section' }, 'Watch out', h('span', {}, red.length), h('span', { class: 'note' }, 'Red players stay at the top for the session')));
      for (const gt of red) listEl.append(renderRow(gt, false));
    }
    if (rest.length) {
      listEl.append(h('div', { class: 'section' }, red.length ? 'Everyone else' : 'Recent encounters', h('span', {}, rest.length), h('span', { class: 'note' }, 'Newest first')));
      for (const gt of rest) listEl.append(renderRow(gt, false));
    }
  }

  // ---------- session recap ----------
  // A session is a run of meetings with no gap over 90 minutes, ending at the latest one. Built from the meeting log.
  const flagScore = (rep) => ((rep.severe_count | 0) + (rep.banned_xuids || []).length) * 100 + (rep.moderate_count | 0) * 10 + (rep.light_count | 0);
  const profileLink = (rep) => rep && rep.profile_id ? `${SOTREP}/search/${rep.profile_id}` : SOTREP + '/';
  function sessionRecap() {
    const hits = [];
    for (const gt of Object.keys(state.seen)) for (const t of meetList(gt)) hits.push([Date.parse(t), gt]);
    hits.sort((a, b) => b[0] - a[0]);
    const ses = sessionOf(hits, false);
    if (!ses) return null;
    if (!ses.members.size) {
      const hm0 = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      return h('section', { class: 'recap', 'aria-label': 'This session' },
        h('div', { class: 'recap-a' }, h('span', { class: 'lbl' }, 'This session'), h('span', { class: 'big' }, 'No one met yet'),
          h('span', { class: 'sub', title: 'Start comes from your Xbox status' }, `Playing since ${hm0(ses.start)}`)));
    }
    const { start, end, members } = ses;
    const n = { red: 0, orange: 0, yellow: 0, clean: 0, unchecked: 0 };
    let again = 0, streamers = 0, liveNow = 0, wasLive = 0, worst = null, best = null;
    const onAir = [];
    for (const gt of members) {
      if (meetList(gt).some(t => Date.parse(t) < start)) again++;
      const e = state.cache[gt], rep = e && e.rep;
      if (!rep || rep.error) { n.unchecked++; continue; }
      const cls = repClass(rep);
      n[{ severe: 'red', moderate: 'orange', light: 'yellow' }[cls] || 'clean']++;
      const login = twitchLogin(rep);
      if (login) {
        streamers++;
        const lv = liveEntry(login);
        if (lv && lv.live && liveFresh(login)) { liveNow++; onAir.push({ gt, rep, lv }); }
        else if (state.lives[gt] && Date.parse(state.lives[gt]) >= start - 60e3) wasLive++;
      }
      const score = flagScore(rep);
      if (score > 0 && (!worst || score > worst.score)) worst = { gt, score, rep };
      if (score === 0 && (rep.badges || []).length && !best) best = { gt, rep };
    }
    const hm = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const mins = Math.max(1, Math.round((end - start) / 60e3));
    const len = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
    const live = ses.playing || Date.now() - end < 3 * 3600e3;
    const parts = [['red', '--c-sev'], ['orange', '--c-mod'], ['yellow', '--c-lt'], ['clean', '--c-ok'], ['unchecked', '--c-l3']].filter(([k]) => n[k]);
    const key = (k, colour) => h('span', { class: 'k' }, h('span', { class: 'dot', style: `background:var(${colour})` }), h('b', {}, n[k]), ' ' + (k === 'unchecked' ? 'not checked' : k));
    const nameLink = (o, href) => h('a', { class: 'name', href, target: '_blank', rel: 'noopener' }, o.gt);
    const card = (cls, label, o, href, sub) => h('div', { class: 'hl ' + cls }, h('span', { class: 'lbl' }, label), nameLink(o, href), h('span', { class: 'sub', title: sub }, sub));
    const extras = [
      again ? `${again} met before` : null,
      streamers ? `${streamers} with a Twitch channel` : null,
      wasLive ? `${wasLive} was live` : null,
    ].filter(Boolean);
    return h('section', { class: 'recap', 'aria-label': live ? 'This session' : 'Last session' },
      h('div', { class: 'recap-a' },
        h('span', { class: 'lbl' }, live ? 'This session' : `Last session, ${dayLabel(new Date(end)).toLowerCase()}`),
        h('span', { class: 'big' }, `${members.size} player${members.size > 1 ? 's' : ''}`),
        h('span', { class: 'sub', title: ses.xbox ? 'Start and end come from your Xbox status' : 'Worked out from when you met players: a gap of over 90 minutes starts a new session' },
          ses.playing ? `Playing since ${hm(start)}, ${len}` : `${hm(start)} to ${hm(end)}, ${len}`)),
      h('div', { class: 'recap-b' },
        h('div', { class: 'riskbar', role: 'img', 'aria-label': parts.map(([k]) => `${n[k]} ${k === 'unchecked' ? 'not checked' : k}`).join(', ') },
          parts.map(([k, colour]) => h('span', { style: `flex:${n[k]};background:var(${colour})` }))),
        h('div', { class: 'legend' }, parts.map(([k, colour]) => key(k, colour)),
          extras.length ? h('span', { class: 'x' }, extras.join(' · ')) : null,
          liveNow ? h('span', { class: 'tag live' }, `${liveNow} LIVE now`) : null),
      ),
      (worst || onAir.length || best) ? h('div', { class: 'recap-c' },
        worst ? card('bad', 'Watch out', worst, profileLink(worst.rep), repLabel(worst.rep)) : null,
        onAir.length === 1 ? card('tw', 'Live on Twitch', onAir[0], onAir[0].lv.url, onAir[0].lv.title || 'Streaming now') : null,
        onAir.length > 1 ? liveCard(onAir, nameLink) : null,
        !onAir.length && best ? card('good', 'Best of the session', best, profileLink(best.rep), tagName(best.rep.badges[0])) : null,
      ) : null,
    );
  }

  // Several streamers live at once: one card naming them all (three, then "+N more"), each linking to their stream
  const LIVE_CARD_NAMES = 3;
  function liveCard(onAir, nameLink) {
    const shown = onAir.slice(0, LIVE_CARD_NAMES), rest = onAir.length - shown.length;
    const names = [];
    shown.forEach((o, i) => { if (i) names.push(', '); const a = nameLink(o, o.lv.url); if (o.lv.title) a.title = o.lv.title; names.push(a); });
    return h('div', { class: 'hl tw' }, h('span', { class: 'lbl' }, `Live on Twitch (${onAir.length})`),
      h('span', { class: 'lives' }, names, rest ? h('span', { class: 'more', title: onAir.slice(LIVE_CARD_NAMES).map(o => o.gt).join(', ') }, ` +${rest} more`) : null));
  }

  // ---------- History search and filters ----------
  const filtersActive = () => { const f = session.hist; return !!(f.q || f.colour !== 'all' || f.streamers || f.repeat); };
  const histColour = (gt) => {
    const e = state.cache[gt], rep = e && e.rep;
    if (!rep || rep.error) return 'unchecked';
    return { severe: 'red', moderate: 'orange', light: 'yellow', clean: 'green' }[repClass(rep)] || 'unchecked';
  };
  function histMatch(gt) {
    const f = session.hist, e = state.cache[gt], rep = e && e.rep;
    const ok = !!rep && !rep.error;
    if (f.q) {
      const hay = [gt, ...(ok ? [...(rep.socials || []).filter(x => x && !x.hidden && x.platform && x.platform !== 'playfab').map(x => x.username), ...(rep.manual_tags || []).map(tagName), ...(rep.badges || []).map(tagName)] : [])];
      if (!hay.some(x => x && String(x).toLowerCase().includes(f.q.toLowerCase()))) return false;
    }
    if (f.colour !== 'all' && histColour(gt) !== f.colour) return false;
    if (f.streamers && !(ok && twitchLogin(rep))) return false;
    if (f.repeat && meetList(gt).length < 2) return false;
    return true;
  }

  // A folded group of rows, drawn only while open. The poll re-renders, so each fold remembers its own state.
  function fold(box, key, title, entries, sortByName, force) {
    session.folds = session.folds || {};
    const open = force || !!session.folds[key];
    const head = h('div', { class: 'tsec fold', role: 'button', tabindex: '0', 'aria-expanded': String(open) }, title, h('span', {}, entries.length), force ? null : h('span', { class: 'hint' }, open ? 'Hide' : `Show ${entries.length}`));
    const flip = () => { session.folds[key] = !open; render(); };
    head.addEventListener('click', flip);
    head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
    box.append(head);
    if (!open) return;
    const rows = sortByName ? [...entries].sort((a, b) => a[0].localeCompare(b[0])) : entries;
    for (const [gt] of rows) box.append(renderRow(gt, true));
  }

  const HISTORY_OPEN_DAYS = 30;   // older encounters sit in a fold so History stays quick to draw
  function renderHistory() {
    const base = baselineStamp();
    const all = Object.entries(state.seen).sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]));
    const cutoff = Date.now() - HISTORY_OPEN_DAYS * 864e5;
    const tally = { all: all.length, red: 0, orange: 0, yellow: 0, green: 0, unchecked: 0 };
    for (const [gt] of all) tally[histColour(gt)]++;
    for (const [k, el] of Object.entries(chipCounts)) el.textContent = tally[k] || 0;
    if (!all.length) { filterCount.textContent = ''; listEl.append(h('div', { class: 'empty' }, 'Nothing recorded yet.')); return; }
    const active = filtersActive();
    const shown = active ? all.filter(([gt]) => histMatch(gt)) : all;
    filterCount.textContent = active ? `${shown.length} of ${all.length}` : `${all.length} players`;
    if (!shown.length) { listEl.append(h('div', { class: 'empty' }, 'No one matches those filters.')); return; }
    const tracked = shown.filter(([, iso]) => iso !== base);
    const recent = tracked.filter(([, iso]) => Date.parse(iso) >= cutoff);
    const older = tracked.filter(([, iso]) => !(Date.parse(iso) >= cutoff));
    const baseline = shown.filter(([, iso]) => iso === base);
    const box = h('div', { class: 'tin' },
      h('div', { class: 'hhead', 'aria-hidden': 'true' }, h('span', {}, 'Player'), h('span', {}, 'Reputation'), h('span', {}, 'Met'), h('span', {}, 'Tags and socials'), h('span', {}, 'Last met')));
    let lastDay = null, dayHead = null, dayN = 0;
    for (const [gt, iso] of recent) {
      const day = dayLabel(new Date(iso));
      if (day !== lastDay) {
        if (dayHead) dayHead.lastChild.textContent = `${dayN}`;
        dayHead = h('div', { class: 'tsec' }, day, h('span', {}));
        box.append(dayHead); lastDay = day; dayN = 0;
      }
      dayN++;
      box.append(renderRow(gt, true));
    }
    if (dayHead) dayHead.lastChild.textContent = `${dayN}`;
    if (older.length) fold(box, 'older', `Older than ${HISTORY_OPEN_DAYS} days`, older, false, active);
    if (baseline.length) fold(box, 'baseline', 'Met before tracking started', baseline, true, active);
    listEl.append(h('div', { class: 'table' }, box));
  }

  // The reputation badge: a shape for each level as well as a colour, so red and orange differ for everyone
  const REP_ICON = { severe: 'severe', moderate: 'moderate', light: 'light', clean: 'clean' };
  const SOCIALS_CARD = 4, SOCIALS_HISTORY = 3;   // socials shown before "+N more"
  function renderRow(gt, inHistory) {
    {
      const cur = session.current.get(gt);
      const entry = state.cache[gt];
      const rep = entry && entry.rep;
      const cls = repClass(rep);
      const link = profileLink(rep);

      const tags = [];
      const socials = [];
      if (rep && !rep.error) {
        for (const t of rep.manual_tags || []) tags.push(h('span', { class: 'tag amber' }, tagName(t)));
        for (const b of rep.badges || []) tags.push(h('span', { class: 'tag green' }, tagName(b)));
        if (rep.pc_check_status) tags.push(h('span', { class: 'tag ' + (/fail/i.test(rep.pc_check_status) ? 'red' : /pass/i.test(rep.pc_check_status) ? 'green' : '') }, `PC check ${rep.pc_check_status}`));
        if ((rep.alts || []).length) tags.push(h('span', { class: 'tag' }, `${rep.alts.length} alt${rep.alts.length > 1 ? 's' : ''}`));
        if ((rep.account_count | 0) > 1) tags.push(h('span', { class: 'tag' }, `${rep.account_count} accounts`));
        if (rep.enriching && (entry.rechecks | 0) < MAX_RECHECKS) tags.push(h('span', { class: 'tag' }, 'updating…'));
        const login = twitchLogin(rep);
        const lv = liveEntry(login);
        if (login && lv && lv.live) tags.unshift(h('a', { class: 'tag live', href: lv.url, target: '_blank', rel: 'noopener', title: lv.title || 'Live on Twitch' }, 'LIVE on Twitch'));
        else if (login && lv && lv.wasLiveAt) tags.unshift(h('a', { class: 'tag wasLive', href: lv.url, target: '_blank', rel: 'noopener', title: 'Was live on Twitch earlier this session' }, `was live ${new Date(lv.wasLiveAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`));
        else if (login && !lv && session.liveQueue.some(q => q.login === login)) tags.push(h('span', { class: 'tag' }, 'checking Twitch…'));
        // Some profiles list dozens of socials (often the same Steam entry over and over). Repeats are merged, Twitch
        // goes first, and only a few show until you open the rest on that card.
        // Repeats share a platform and name; distinct linked accounts with the same name are kept, and a linked copy
        // wins over a bare one.
        const groups = new Map();
        for (const x of (rep.socials || []).filter(x => x && !x.hidden && x.platform && x.platform !== 'playfab')) {
          const k = String(x.platform).toLowerCase() + '|' + String(x.username || x.platform).toLowerCase().trim();
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(x);
        }
        const soc = [];
        for (const arr of groups.values()) {
          const linked = arr.filter(x => /^https:\/\//i.test(String(x.link || '')));
          if (!linked.length) { soc.push(arr[0]); continue; }
          const seenLink = new Set();
          for (const x of linked) { const l = String(x.link).toLowerCase().replace(/\/+$/, ''); if (!seenLink.has(l)) { seenLink.add(l); soc.push(x); } }
        }
        // Twitch first; in a History search, whatever matched comes before everything so it is never hidden
        const q = inHistory && session.hist.q ? session.hist.q.toLowerCase() : '';
        const rank = (x) => (q && String(x.username || '').toLowerCase().includes(q) ? 2 : 0) + (String(x.platform).toLowerCase() === 'twitch' ? 1 : 0);
        soc.sort((a, b) => rank(b) - rank(a));
        const cap = inHistory ? SOCIALS_HISTORY : SOCIALS_CARD;
        const open = session.socOpen.has(gt);
        const show = open || soc.length <= cap + 1 ? soc : soc.slice(0, cap);
        show.forEach((s) => {
          const label = s.username || s.platform;
          const p = String(s.platform).toLowerCase();
          const badge = h('span', { class: 'pbadge ' + p, title: s.platform }, PLATFORM_LETTER[p] || p.charAt(0).toUpperCase());
          // links come from other players' sotrep profiles: only plain https, never javascript: or similar
          socials.push(/^https:\/\//i.test(String(s.link || ''))
            ? h('a', { class: 'soc', href: s.link, target: '_blank', rel: 'noopener', title: s.platform }, badge, label)
            : h('span', { class: 'soc', title: s.platform }, badge, label));
        });
        if (show.length < soc.length || open && soc.length > cap + 1) {
          const flip = () => { if (open) session.socOpen.delete(gt); else session.socOpen.add(gt); render(); };
          socials.push(h('button', { class: 'soc more', 'aria-expanded': String(open), onclick: flip,
            title: open ? '' : soc.slice(cap).map(s => s.username || s.platform).join(', ') }, open ? 'Show fewer' : `+${soc.length - cap} more`));
        }
      }

      const times = meetList(gt);
      const timesTitle = times.length ? 'Met ' + times.map(t => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })).join(', ') : '';
      const metBadge = !inHistory && times.length >= 2 ? (() => {
        const d = dayLabel(new Date(times[times.length - 2]));
        const when = d === 'Today' ? 'earlier today' : d === 'Yesterday' ? 'yesterday' : d;
        return h('span', { class: 'tag met', title: timesTitle }, `met ${times.length} times, before that ${when}`);
      })() : null;
      const pic = (cur && cur.DisplayPicUrl) || (rep && rep.gamerpic_url) || '';
      // Rare passes on Xbox Live presence as your account sees it. "Offline" would be misleading on a board of
      // people you just met, so the absence of a signal is shown as hidden rather than as a claim they are away.
      const presence = !cur ? ['', 'manual lookup', '']
        : cur.IsPlayingSot ? ['sot', 'Playing SoT', 'Xbox Live says this player is in Sea of Thieves right now']
        : cur.IsOnline ? ['on', 'Online', 'Xbox Live says this player is online']
        : ['', '', 'Xbox Live is not sharing this player\'s status with you (privacy setting or appear offline). They were on your server when first seen.'];
      const first = state.seen[gt] ? new Date(state.seen[gt]) : null;
      const queued = session.queue.includes(gt);
      // In history, unchecked names are not looked up automatically; offer a button instead
      const needsLookup = inHistory && !entry && !queued;
      const repText = needsLookup ? 'not checked' : queued && !entry ? 'queued…' : repLabel(rep);
      const shape = !needsLookup && REP_ICON[cls];

      const picEl = pic ? h('img', { class: 'pic', src: pic, alt: '' }) : h('div', { class: 'pic', 'aria-hidden': 'true' }, gt.trim().charAt(0).toUpperCase());
      const nameEl = h('a', { class: 'name', href: link, target: '_blank', rel: 'noopener' }, gt);
      const repEl = h('span', { class: 'rep' }, shape ? icon(shape, 13, 2.4) : null, repText);
      const actions = [
        needsLookup ? h('button', { class: 'mini', onclick: () => { session.manual.add(gt); enqueue(gt, true); render(); } }, 'Look up') : null,
        rep && rep.error ? h('button', { class: 'mini', onclick: () => { delete state.cache[gt]; save(['cache']); enqueue(gt, true); render(); } }, 'Retry') : null,
      ];
      const rowCls = 'row ' + (needsLookup ? 'unchecked' : cls);
      // reactions: only for someone the game put on the board this session, never a name typed by hand
      const xuid = rep && !rep.error && rep.xuid ? String(rep.xuid) : null;
      const canReact = !inHistory && !!xuid && !!cur && !session.manual.has(gt);

      if (inHistory) {
        return h('div', { class: rowCls + ' hrow' },
          h('div', { class: 'who' }, picEl, nameEl),
          h('div', { class: 'line' }, repEl, actions),
          h('span', { class: 'times', title: timesTitle }, times.length ? `${times.length} time${times.length > 1 ? 's' : ''}` : ''),
          h('div', { class: 'meta' }, tags, socials),
          h('span', { class: 'when', title: presence[2] }, first ? first.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''),
        );
      }
      return h('div', { class: rowCls },
        picEl,
        h('div', { class: 'main' },
          h('div', { class: 'line' }, nameEl, repEl, actions),
          (tags.length || socials.length || metBadge) ? h('div', { class: 'meta' }, metBadge, tags, socials.length ? h('span', { class: 'social' }, socials) : null) : null,
        ),
        h('div', { class: 'side', title: presence[2] },
          presence[1] ? h('span', { class: 'pres ' + presence[0] }, presence[0] ? h('span', { class: 'dot' }) : null, presence[1]) : null,
          first ? h('span', {}, 'met ' + first.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })) : null,
          rep && rep.profile_id ? h('a', { class: 'prof', href: link, target: '_blank', rel: 'noopener' }, 'SoT Rep profile') : null,
          canReact ? h('button', { class: 'mini react-btn', 'aria-expanded': String(reactState(xuid).open), onclick: () => openReactions(xuid) }, reactState(xuid).open ? 'Hide reactions' : 'React') : null,
        ),
        canReact ? reactRow(xuid) : null,
      );
    }
  }

  // ---------- reactions on sotrep.com ----------
  // The same four reactions as a sotrep.com profile, with your own sotrep login. Only for players the game put on your
  // Recent board (never names typed by hand), and nothing is sent until you press React. sotrep's endpoint is a toggle,
  // so the chips only show once your current reactions have been read, and they are read again every time the panel
  // opens and after any failure that leaves the state in doubt. Every request, read or toggle, goes through one queue
  // REACT_GAP_MS apart, and the pause and sign-in state are checked again just before each one is sent.
  const REACTIONS = [['cheater', 'Suspicious'], ['skilled', 'Skilled'], ['clown', 'Clown'], ['helpful', 'Friendly']];
  const REACT_GAP_MS = 1500;
  let lastReactAt = 0, reactPauseUntil = 0, reactChain = Promise.resolve();
  function reactState(xuid) {
    let r = session.react.get(xuid);
    if (!r) { r = { open: false, loaded: false, loading: false, busy: false, mine: [], counts: {}, msg: '' }; session.react.set(xuid, r); }
    return r;
  }
  function takeReactions(r, d) {
    if (!plain(d)) return;
    if (Array.isArray(d.my_reactions)) r.mine = d.my_reactions.map(String);
    if (plain(d.reactions)) r.counts = Object.fromEntries(Object.entries(d.reactions).map(([k, v]) => [k, v | 0]));
  }
  // why reacting cannot go ahead right now, or '' when it can
  function reactBlocked() {
    if (session.sotrepSignedOut) return 'Sign in to sotrep.com to react (button at the top)';
    const paused = Math.max(reactPauseUntil, session.pauseUntil || 0);
    if (Date.now() < paused) return `sotrep.com asked us to wait, try again after ${new Date(paused).toLocaleTimeString('en-GB')}`;
    return '';
  }
  function sotrepSend(method, path) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method, url: SOTREP + path, headers: { Accept: 'application/json' }, timeout: 15000,
        onload: (res) => {
          let d = {}; try { d = JSON.parse(res.responseText) || {}; } catch (e) {}
          const ra = ((res.responseHeaders || '').match(/retry-after:\s*(\d+)/i) || [])[1];
          resolve({ status: res.status, data: d, retry: ra ? parseInt(ra, 10) : 0 });
        },
        onerror: () => resolve({ status: 0, data: { error: 'could not reach sotrep.com' } }),
        ontimeout: () => resolve({ status: 0, data: { error: 'sotrep.com timed out' } }),
      });
    });
  }
  function reactRequest(method, path) {
    const job = reactChain.then(async () => {
      const wait = lastReactAt + REACT_GAP_MS - Date.now();
      if (wait > 0) await new Promise(res => setTimeout(res, wait));
      const blocked = reactBlocked();
      if (blocked) return { blocked };
      lastReactAt = Date.now();
      return sotrepSend(method, path);
    });
    reactChain = job.catch(() => {});
    return job;
  }
  const reactOk = (res) => res.status >= 200 && res.status < 300 && !(res.data && res.data.error);
  // Turns a failed reply into words. Also sets the pause or the signed-out flag, and says whether we still know
  // your reactions for sure (keep) or must read them again before the next toggle.
  function reactError(res, label) {
    const err = res.data && res.data.error;
    if (res.status === 401) { if (!session.sotrepSignedOut) { session.sotrepSignedOut = true; refreshStatus(); } return { msg: 'Sign in to sotrep.com to react (button at the top)', keep: false }; }
    if (res.status === 403 && res.data && res.data.require_captcha) {
      // the same pause lookups use: the status line offers Open sotrep.com, and coming back to this tab lifts it
      session.pauseUntil = Date.now() + 300e3; session.pauseFix = true;
      session.pauseReason = 'sotrep.com wants a captcha: open sotrep.com, search any name there, then come back';
      refreshStatus();
      return { msg: 'sotrep.com wants a quick captcha check. Use Open sotrep.com at the top, do it there, then come back and Reload', keep: false };
    }
    if (err === 'reaction_cooldown') return { msg: `Wait a second before selecting ${label} again`, keep: true };
    if (err === 'account_too_new') return { msg: 'Your sotrep.com account is too new to react yet', keep: true };
    if (err === 'terms_not_accepted') return { msg: 'Accept the sotrep.com terms first: react once on their profile there, then Reload', keep: false };
    if (err === 'username_requirements_not_met') return { msg: 'Finish setting up your sotrep.com account first, then Reload', keep: false };
    if (res.status === 429 || res.status === 403) {
      const wait = Math.min(Math.max(res.retry || 60, 30), 900);
      reactPauseUntil = Date.now() + wait * 1000;
      return { msg: `sotrep.com asked us to slow down, reacting paused for ${wait >= 120 ? Math.round(wait / 60) + ' minutes' : wait + ' seconds'}`, keep: true };
    }
    return { msg: 'sotrep.com said: ' + (err ? String(err).slice(0, 120) : 'error ' + res.status), keep: false };
  }
  async function loadReactions(xuid) {
    const r = reactState(xuid);
    if (r.loading) return;
    r.loading = true; r.loaded = false; r.msg = ''; render();
    const res = await reactRequest('GET', `/api/player/${encodeURIComponent(xuid)}/reviews?sort=popular`);
    r.loading = false;
    if (res.blocked) r.msg = res.blocked;
    // the chips only show when sotrep says which reactions are yours; without that list a click could undo one
    else if (reactOk(res) && plain(res.data) && Array.isArray(res.data.my_reactions)) { r.mine = []; r.counts = {}; takeReactions(r, res.data); r.loaded = true; }
    else if (reactOk(res)) r.msg = 'sotrep.com did not say which reactions are yours, so React is off for now';
    else r.msg = 'Could not load reactions. ' + reactError(res, '').msg;
    render();
  }
  function openReactions(xuid) {
    const r = reactState(xuid);
    r.open = !r.open;
    if (r.open) loadReactions(xuid);   // read afresh every time: you may have reacted on sotrep.com in the meantime
    else render();
  }
  async function toggleReaction(xuid, type, label) {
    const r = reactState(xuid);
    if (!r.loaded || r.loading || r.busy) return;   // never toggle blind
    r.busy = true; r.msg = ''; render();
    const res = await reactRequest('POST', `/api/player/${encodeURIComponent(xuid)}/reactions/${encodeURIComponent(type)}/toggle`);
    r.busy = false;
    if (res.blocked) r.msg = res.blocked;   // nothing was sent, so what we know still stands
    else if (reactOk(res)) {
      const was = r.mine.includes(type);
      r.mine = was ? r.mine.filter(t => t !== type) : [...r.mine, type];
      r.counts[type] = Math.max(0, (r.counts[type] | 0) + (was ? -1 : 1));
      takeReactions(r, res.data);   // if sotrep sends the new state back, trust it over our own count
    } else {
      const e = reactError(res, label);
      r.msg = e.msg;
      if (!e.keep) r.loaded = false;
    }
    render();
  }
  function reactRow(xuid) {
    const r = reactState(xuid);
    if (!r.open) return null;
    let body;
    if (r.loading) body = h('span', { class: 'note' }, 'Loading…');
    else if (!r.loaded) body = h('button', { class: 'mini', onclick: () => loadReactions(xuid) }, 'Reload');
    else body = REACTIONS.map(([type, label]) => {
      const on = r.mine.includes(type);
      const b = h('button', { class: 'rchip' + (on ? ' on' : ''), 'aria-pressed': String(on), title: on ? `Take back ${label}` : label, onclick: () => toggleReaction(xuid, type, label) },
        label, h('span', { class: 'n' }, r.counts[type] | 0));
      if (r.busy) b.disabled = true;
      return b;
    });
    return h('div', { class: 'react', role: 'group', 'aria-label': 'Reactions on sotrep.com' },
      body,
      r.msg ? h('span', { class: 'msg' }, r.msg) : null,
      h('span', { class: 'via' }, 'on sotrep.com'),
    );
  }

  // ---------- data: Recently Met ----------
  async function fetchRecent() {
    // A hung request would stop the self-scheduling poll loop for good, so give it a hard 20 s limit.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    let r;
    try {
      r = await fetch(RECENT_URL, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    } catch (e) {
      throw Object.assign(new Error(e && e.name === 'AbortError' ? 'seaofthieves.com did not answer, retrying in a minute' : 'could not reach seaofthieves.com, retrying in a minute'), { backoff: 60 });
    } finally {
      clearTimeout(t);
    }
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Not signed in to seaofthieves.com'), { signedOut: true });
    if (r.status === 429) throw Object.assign(new Error('seaofthieves.com asked us to slow down, waiting 5 minutes'), { backoff: 300 });
    if (r.status >= 500) throw Object.assign(new Error(`seaofthieves.com error ${r.status}, waiting 2 minutes`), { backoff: 120 });
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) throw Object.assign(new Error('Unexpected reply from seaofthieves.com (session expired?)'), { backoff: 120 });
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error('Unexpected shape from get-recent-friends');
    return j;
  }

  // Adaptive polling. Rare's list changes only when you actually meet someone, so there is no point asking every
  // 20 s all night. Fast while things are happening, slower when quiet, slower again when the tab is hidden and quiet.
  const POLL_FAST_MS = POLL_SECONDS * 1000;   // list changed in the last 10 minutes
  const POLL_SLOW_MS = 60 * 1000;             // nothing new for 10 minutes
  const POLL_IDLE_MS = 180 * 1000;            // nothing new for 30 minutes and the tab is hidden
  let lastChangeAt = Date.now();
  let pollTimer = null;
  function nextPollDelay() {
    const quiet = Date.now() - lastChangeAt;
    if (quiet > 30 * 60e3 && document.hidden) return POLL_IDLE_MS;
    if (quiet > 10 * 60e3) return POLL_SLOW_MS;
    return POLL_FAST_MS;
  }
  function schedulePoll(delayMs) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, delayMs);
  }
  // coming back to the tab after a quiet spell: poll straight away rather than waiting out a long idle timer
  document.addEventListener('visibilitychange', () => { if (!session.signedOut && !document.hidden && session.lastPoll && Date.now() - session.lastPoll > POLL_FAST_MS) schedulePoll(500); });

  // Signed out of either site: no timer retries at all. Coming back to this tab (focus or visible) is the retry,
  // at most one per SIGNIN_RETRY_GAP_MS however often the tab flaps, and a failed retry just parks again.
  const SIGNIN_RETRY_GAP_MS = 15000;
  let lastSigninRetry = 0;
  // One request to find out whether you have signed back in to sotrep.com. With lookups waiting, the first of them is
  // the probe; with none waiting, one search for your own gamertag does it (the reply clears the flag or sets a pause).
  async function probeSotrep() {
    if (session.queue.length) { session.sotrepTry = true; pump(); return; }
    const gt = (state.me && state.me.gt) || myGamertag();
    if (!gt) return;
    const rep = await sotrepSearchAs(gt, 'xbox');
    // keep the Xbox ID it found, so the presence check does not search for you again
    if (!rep.error && rep.xuid && gt === myGamertag()) { state.me = { gt, xuid: String(rep.xuid) }; save(['me']); }
    if (rep.pause) {
      session.pauseUntil = Date.now() + rep.pause * 1000; session.pauseReason = rep.error; session.pauseFix = !!rep.fix;
      setStatus(statusLine(), true);
    }
  }
  function retryAfterSignIn() {
    if (document.hidden || (!session.signedOut && !session.sotrepSignedOut && !fixing())) return;
    if (Date.now() - lastSigninRetry < SIGNIN_RETRY_GAP_MS) return;
    lastSigninRetry = Date.now();
    if (session.signedOut) { clearTimeout(pollTimer); poll(); }
    if (session.sotrepSignedOut) probeSotrep();
    if (fixing()) { session.pauseUntil = 0; session.pauseFix = false; setStatus(statusLine()); }   // pump's wait loop then makes one lookup; a repeat refusal pauses again
  }
  window.addEventListener('focus', retryAfterSignIn);
  document.addEventListener('visibilitychange', retryAfterSignIn);

  // Watchdog: if no poll has started for well over the longest planned gap, the loop has stalled; restart it.
  let pollInFlight = false, lastPollStart = 0;
  setInterval(() => {
    if (!session.signedOut && !pollInFlight && lastPollStart && Date.now() - lastPollStart > POLL_IDLE_MS + 60000) schedulePoll(0);
  }, 60000);

  async function poll() {
    if (pollInFlight) return;
    pollInFlight = true;
    lastPollStart = Date.now();
    let delay = null;
    try {
      const list = await fetchRecent();
      session.signedOut = false;
      if (list.length !== session.count) lastChangeAt = Date.now();
      session.count = list.length;
      const now = new Date().toISOString();
      const fresh = [];
      const MISSING_POLLS = 2;   // a name must be gone this many polls before its return counts as meeting them again
      const present = {};
      let changed = false;
      for (const p of list) {
        if (!p || !p.Gamertag) continue;
        const gt = p.Gamertag;
        present[gt] = true;
        session.current.set(gt, p);
        if (!state.seen[gt]) {
          // never seen: a new encounter
          state.seen[gt] = now;
          changed = true;
          if (state.baselined) { fresh.push(gt); recordMeet(gt, now, null); }
        } else if (state.inList && !state.inList[gt] && (state.missing[gt] | 0) >= MISSING_POLLS) {
          // seen before, dropped off Rare's rolling list, now back: you met them again
          // the 24 h cache still applies, so a quick return costs no new lookup
          recordMeet(gt, now, state.seen[gt]);
          state.seen[gt] = now;
          fresh.push(gt);
        }
        if (gt in state.missing) { delete state.missing[gt]; changed = true; }
      }
      // count how long each name has been absent: everyone listed last time plus everyone already counting.
      // Capped at MISSING_POLLS, which is all the re-meet check needs, so a long-gone name stops changing.
      if (state.inList) {
        for (const gt of new Set([...Object.keys(state.inList), ...Object.keys(state.missing)])) {
          if (present[gt] || (state.missing[gt] | 0) >= MISSING_POLLS) continue;
          state.missing[gt] = (state.missing[gt] | 0) + 1;
          changed = true;
        }
        if (Object.keys(state.inList).length !== Object.keys(present).length || Object.keys(present).some(gt => !state.inList[gt])) changed = true;
      } else changed = true;
      state.inList = present;
      if (!state.baselined) { state.baselined = true; state.baselineAt = now; }
      if (changed || fresh.length) save(['seen', 'meets', 'inList', 'missing', 'baselined', 'baselineAt']);
      for (const gt of fresh) {
        session.order = [gt, ...session.order.filter(x => x !== gt)];   // to the top, even if already on the board
        session.manual.delete(gt);                                        // the game found them this time, so alerts apply
        enqueue(gt);
      }
      // anyone restored from a previous page load still needs their lookup if it is missing or stale.
      // A player whose last lookup errored is left alone (Retry button on the row) so we never hammer sotrep.
      for (const gt of session.order) {
        const c = state.cache[gt];
        if (c && c.rep && c.rep.error) continue;
        if (!cacheFresh(gt) && !session.queue.includes(gt)) enqueue(gt);
      }
      // keep live status current for streamers on the Recent board
      for (const gt of session.order) { const c = state.cache[gt]; if (c && c.rep && !c.rep.error) queueLiveCheck(gt, twitchLogin(c.rep)); }
      if (fresh.length) lastChangeAt = Date.now();
      session.lastPoll = new Date();
      setStatus(statusLine());
      // redraw only when the list or someone's presence changed; the 20 s poll is otherwise a no-op on screen
      const sig = list.map(p => p && `${p.Gamertag}|${p.IsOnline ? 1 : 0}${p.IsPlayingSot ? 1 : 0}|${p.DisplayPicUrl || ''}`).join('\n');
      if (sig !== session.listSig || fresh.length) { session.listSig = sig; render(); }
    } catch (e) {
      if (e && e.signedOut) session.signedOut = true;   // only a good reply clears it, not some other error
      setStatus(e && e.signedOut ? e.message : 'Problem: ' + (e.message || String(e)), true);
      if (e && e.backoff) delay = e.backoff * 1000;
    }
    pollInFlight = false;
    // signed out: no fast polling. Returning to the tab retries (retryAfterSignIn); this slow timer covers a tab that never loses focus
    schedulePoll(delay || (session.signedOut ? SIGNIN_FALLBACK_MS : nextPollDelay()));
  }

  // ---------- data: SOTREP ----------
  // Try as an Xbox gamertag first; if sotrep has no such player, try the same text as a Twitch channel name,
  // which resolves a streamer to their linked pirate.
  async function sotrepSearch(gamertag) {
    const xbox = await sotrepSearchAs(gamertag, 'xbox');
    if (!xbox.error || !/not found/i.test(xbox.error)) return xbox;
    // Only a hand-typed name might be a Twitch channel. Names from Rare are real gamertags, so a miss there
    // just means sotrep has no record of them; no point in a second request.
    if (!session.manual.has(gamertag)) return xbox;
    const twitch = await sotrepSearchAs(gamertag, 'twitch');
    if (!twitch.error) { twitch.resolved_via = 'twitch'; return twitch; }
    return xbox;
  }
  function sotrepSearchAs(query, type) {
    // Watchdog: Tampermonkey's own timeout only starts once the request is allowed. If its cross-site permission
    // prompt is sitting unanswered, nothing ever fires, so resolve ourselves after 30 s with a pointer to the fix.
    const watchdog = new Promise((resolve) => setTimeout(() => resolve({
      error: 'no reply from sotrep.com. Click the Tampermonkey icon and allow access to sotrep.com, then Retry',
    }), 30000));
    return Promise.race([watchdog, new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: SOTREP + '/api/search',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        data: JSON.stringify({ query, search_type: type }),
        timeout: 20000,
        onload: (res) => {
          // sotrep may say how long to wait; otherwise default to a minute
          const ra = ((res.responseHeaders || '').match(/retry-after:\s*(\d+)/i) || [])[1];
          const wait = ra ? Math.min(Math.max(parseInt(ra, 10), 30), 900) : 60;
          const waitTxt = wait >= 120 ? `${Math.round(wait / 60)} minutes` : `${wait} seconds`;
          if (res.status === 401) { if (!session.sotrepSignedOut) { session.sotrepSignedOut = true; refreshStatus(); } return resolve({ error: 'sign in to sotrep.com', signin: true }); }
          // any answer but 401 or a server error means we are signed in (a 403 or 429 is a different pause)
          if (session.sotrepSignedOut && res.status < 500) { session.sotrepSignedOut = false; refreshStatus(); }
          if (res.status === 403) {
            let d = {}; try { d = JSON.parse(res.responseText) || {}; } catch (e) {}
            if (d.require_captcha) return resolve({ error: 'sotrep.com wants a captcha: open sotrep.com, search any name there, then retry', pause: 300, fix: true });
            if (d.error === 'username_requirements_not_met') return resolve({ error: 'sotrep.com needs your account set up: open sotrep.com and finish sign-up', pause: 300, fix: true });
            return resolve({ error: `sotrep.com rate limit, paused ${waitTxt}`, pause: wait });
          }
          if (res.status === 429) return resolve({ error: `sotrep.com rate limit, paused ${waitTxt}`, pause: wait });
          try {
            const j = JSON.parse(res.responseText);
            if (j.error) return resolve({ error: String(j.error) });
            resolve(j);
          } catch (e) { resolve({ error: 'bad reply from sotrep.com' }); }
        },
        onerror: () => resolve({ error: 'could not reach sotrep.com' }),
        ontimeout: () => resolve({ error: 'sotrep.com timed out' }),
      });
    })]);
  }

  const MAX_RECHECKS = 1;   // how many times to go back for a player sotrep is "still enriching" (one is enough; keeps requests down)
  function cacheFresh(gt) {
    const c = state.cache[gt];
    if (!c || !c.rep || c.rep.error) return false;
    if ((Date.now() - c.at) >= CACHE_HOURS * 3600e3) return false;
    // still enriching: stale only while we have re-checks left
    if (c.rep.enriching && (c.rechecks | 0) < MAX_RECHECKS) return false;
    return true;
  }

  function enqueue(gt, force) {
    if (!force && cacheFresh(gt)) return;
    if (!session.queue.includes(gt)) session.queue.push(gt);
    pump();
  }

  async function pump() {
    if (session.busy) return;
    if (session.sotrepSignedOut && !session.sotrepTry) return;   // signed out: wait for retryAfterSignIn
    session.busy = true;
    while (session.queue.length) {
      if (session.sotrepSignedOut && !session.sotrepTry) break;
      // sotrep said stop (captcha, rate limit, not signed in): hold the whole queue until the pause is over
      if (session.pauseUntil && Date.now() < session.pauseUntil) {
        setStatus(`Lookups paused until ${new Date(session.pauseUntil).toLocaleTimeString('en-GB')} · ${session.pauseReason || 'sotrep.com asked us to wait'}`, true);
        await new Promise(r => setTimeout(r, Math.min(session.pauseUntil - Date.now(), 15000)));
        continue;
      }
      let gt = session.queue.shift();
      setStatus(statusLine());
      session.sotrepTry = false;   // that one probe is spent
      const rep = await sotrepSearch(gt);
      if (rep.signin) {
        session.queue.unshift(gt);        // not the player's fault; lookups resume once you are back and signed in
        setStatus(statusLine(), true);
        render();
        break;
      }
      if (rep.pause) {
        session.pauseUntil = Date.now() + rep.pause * 1000;
        session.pauseReason = rep.error;
        session.pauseFix = !!rep.fix;
        session.queue.unshift(gt);        // put it back; it was not the player's fault
        render();
        continue;
      }
      // typed a Twitch name (or a differently-cased gamertag): carry on under the real gamertag
      if (!rep.error && rep.gamertag && rep.gamertag !== gt && !session.current.has(gt)) {
        const real = rep.gamertag;
        session.order = session.order.map(x => x === gt ? real : x).filter((x, i, a) => a.indexOf(x) === i);
        if (session.manual.has(gt)) session.manual.add(real);
        if (!state.seen[real]) { state.seen[real] = state.seen[gt] || new Date().toISOString(); state.meets[real] = []; }
        delete state.seen[gt]; delete state.cache[gt]; delete state.meets[gt];
        gt = real;
      }
      const prev = state.cache[gt];
      const rechecks = prev && prev.rep && prev.rep.enriching ? (prev.rechecks | 0) + 1 : 0;
      state.cache[gt] = { at: Date.now(), rep, rechecks, picRetried: !!(prev && prev.picRetried) };
      save(['seen', 'cache']);
      render();
      if (rep.enriching && !rep.error && rechecks < MAX_RECHECKS) {
        // SOTREP is still resolving this player in the background; go back for the rest shortly.
        setTimeout(() => { if (!session.queue.includes(gt)) { session.queue.push(gt); pump(); } }, 15000);
      } else if (!rep.error && !rep.gamerpic_url && !session.current.has(gt) && !state.cache[gt].picRetried) {
        // manual lookup with no picture yet: sotrep usually has fetched one a minute later, look once more
        state.cache[gt].picRetried = true;
        setTimeout(() => { if (!session.queue.includes(gt)) { session.queue.push(gt); pump(); } }, 60000);
      }
      // alert only on the first result for a player, not on enrichment re-checks
      if (!rep.error && session.order.includes(gt) && !session.manual.has(gt) && !(prev && prev.rep && !prev.rep.error)) fireAlerts(gt, rep);
      if (!rep.error && session.order.includes(gt)) queueLiveCheck(gt, twitchLogin(rep));
      await new Promise(r => setTimeout(r, LOOKUP_GAP_MS));
    }
    session.busy = false;
    if (session.lastPoll) setStatus(statusLine());
  }

  // ---------- actions ----------
  function checkName() {
    const gt = nameBox.value.trim();
    if (!gt) return;
    nameBox.value = '';
    session.manual.add(gt);
    if (!session.order.includes(gt)) session.order.unshift(gt);
    if (!state.seen[gt]) { state.seen[gt] = new Date().toISOString(); state.meets[gt] = []; }   // looked up by hand, not a meeting
    delete state.cache[gt];   // you asked by hand, so always fetch fresh
    save(['seen', 'meets', 'cache']);
    enqueue(gt);
    render();
  }
  function clearSession() { session.order = []; session.queue = []; render(); setStatus(statusLine()); }
  function resetAll() {
    state.seen = {}; state.cache = {}; state.baselined = false; state.baselineAt = null; state.inList = null; state.missing = {}; state.meets = {}; state.lives = {}; state.play = null; save();
    session.order = []; session.queue = [];
    poll();
  }

  // ---------- go ----------
  buildUI();
  poll();   // schedules itself afterwards at the adaptive interval
  setTimeout(checkMe, 4000);   // after the first poll, so the first sotrep requests are not bunched together
  checkForUpdate();
  setInterval(checkForUpdate, 6 * 3600e3);
})();

// ==UserScript==
// @name         SOTREP Live - players I meet
// @namespace    https://www.sotrep.com/
// @version      0.9.0
// @description  Watches the Sea of Thieves "Recently Met" list and shows each newly met player with their SOTREP reputation, live, while you play.
// @homepageURL  https://github.com/MrNickIE/sotrep-live
// @updateURL    https://raw.githubusercontent.com/MrNickIE/sotrep-live/main/sotrep-live.user.js
// @downloadURL  https://raw.githubusercontent.com/MrNickIE/sotrep-live/main/sotrep-live.user.js
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
  - Players first seen in the last RECENT_WINDOW_MIN minutes (20) stay on the board across a page refresh.
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
  const RECENT_WINDOW_MIN = 20;   // players first seen within this window survive a refresh
  const SOTREP = 'https://www.sotrep.com';
  const RECENT_URL = '/api/users/get-recent-friends';

  // ---------- persistent state ----------
  const state = {
    seen: GM_getValue('seen', {}),        // gamertag -> first seen ISO time
    cache: GM_getValue('cache', {}),      // gamertag -> { at, rep }
    baselined: GM_getValue('baselined', false),
    baselineAt: GM_getValue('baselineAt', null),   // ISO stamp shared by every name in the first poll
    inList: GM_getValue('inList', null),           // gamertag -> true for everyone present at the last poll (null until first poll)
    missing: GM_getValue('missing', {}),           // gamertag -> consecutive polls absent from the list
    alerts: Object.assign(
      { sound: true, discord: '', desktop: false, severe: true, moderate: true, streamers: true },
      GM_getValue('alerts', {}),
    ),
  };
  // older versions stored a single threshold; carry it over once
  if (state.alerts.threshold) { state.alerts.moderate = state.alerts.threshold === 'moderate'; delete state.alerts.threshold; }
  const save = () => {
    GM_setValue('seen', state.seen);
    GM_setValue('cache', state.cache);
    GM_setValue('baselined', state.baselined);
    GM_setValue('baselineAt', state.baselineAt);
    GM_setValue('inList', state.inList);
    GM_setValue('missing', state.missing);
    GM_setValue('alerts', state.alerts);
  };

  // in-memory
  const session = {
    order: [],          // gamertags on the board, newest first
    current: new Map(), // gamertag -> {IsOnline, IsPlayingSot, DisplayPicUrl}
    queue: [],
    busy: false,
    lastPoll: null,
    count: 0,
    view: 'recent',     // 'recent' | 'history'
    manual: new Set(),  // gamertags looked up by hand (Check box, History button): never alert on these
    live: new Map(),    // twitch login -> { at, live, title, url }
    liveQueue: [],
    liveBusy: false,
  };
  const LIVE_TTL_MS = 5 * 60e3;       // how long a Twitch live/offline answer is trusted
  const LIVE_GAP_MS = 2000;           // pause between Twitch page checks

  // Restore anyone first seen recently so a refresh does not wipe the board mid-session.
  // Baseline names (everyone present on the very first poll) are never "recent", whatever their stamp.
  {
    const cutoff = Date.now() - RECENT_WINDOW_MIN * 60e3;
    session.order = Object.entries(state.seen)
      .filter(([, iso]) => iso !== state.baselineAt && Date.parse(iso) >= cutoff)
      .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
      .map(([gt]) => gt);
  }

  // ---------- UI (inside a shadow root so site CSS cannot reach it) ----------
  const css = `
    :host{all:initial}
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    .root{position:fixed;inset:0;z-index:2147483000;background:#0e1114;color:#e6e4dd;
      font:13px/1.45 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;overflow-y:auto}
    .bar{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:10px;height:48px;padding:0 16px;
      background:#141920;border-bottom:1px solid #222a34}
    .brand{font-weight:700;font-size:14px;letter-spacing:.02em;white-space:nowrap}
    .brand b{color:#7fb7ff;font-weight:700}
    .ver{margin-left:8px;font-size:11px;font-weight:500;color:#6f7986;text-decoration:none;padding:1px 6px;border-radius:999px;border:1px solid #2a3340;vertical-align:middle}
    .ver:hover{color:#e6e4dd;border-color:#3a4454}
    .ver.stale{color:#e6b85c;border-color:#6b4a1a;background:#3a2d12}
    .status{color:#8a93a0;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
    .status .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#2f9e63;margin-right:6px;vertical-align:middle}
    .status .dot.err{background:#d6453d}
    .search{display:flex;align-items:center;background:#0e1114;border:1px solid #2a3340;border-radius:6px;height:30px;overflow:hidden}
    .search input{all:unset;width:190px;height:30px;padding:0 10px;color:#e6e4dd;font:12.5px ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
    .search input::placeholder{color:#5e6875}
    .search button{all:unset;cursor:pointer;height:30px;padding:0 10px;color:#9fb3c8;font-size:12px;border-left:1px solid #2a3340}
    .search button:hover{background:#1b2230;color:#e6e4dd}
    .btn{all:unset;cursor:pointer;height:30px;padding:0 10px;border-radius:6px;border:1px solid #2a3340;background:#161c24;color:#c7cdd6;font-size:12px;white-space:nowrap}
    .btn:hover{background:#1f2733;color:#fff}
    .btn.quiet{border-color:transparent;background:transparent;color:#8a93a0}
    .btn.quiet:hover{background:#1f2733;color:#e6e4dd}
    .btn.armed,.btn.armed:hover{background:#6b2320;border-color:#8a2f2b;color:#fff}
    .tabs{display:flex;background:#0e1114;border:1px solid #2a3340;border-radius:6px;height:30px;overflow:hidden}
    .tab{all:unset;cursor:pointer;height:30px;padding:0 12px;font-size:12px;color:#8a93a0}
    .tab:hover{color:#e6e4dd}
    .tab.on{background:#1f2733;color:#f2f1ec}
    .mini{all:unset;cursor:pointer;font-size:11px;line-height:18px;height:18px;padding:0 8px;border-radius:4px;border:1px solid #2a3340;color:#9fb3c8}
    .mini:hover{background:#1f2733;color:#fff}
    .row.unchecked{opacity:.75}
    .section.fold{cursor:pointer;margin-top:18px;user-select:none}
    .section.fold:hover{color:#aeb7c2}
    .section .hint{margin-left:auto;text-transform:none;letter-spacing:0;color:#7fb7ff;font-size:11px}
    .btn.on{background:#1f2733;color:#f2f1ec}
    .banner{position:sticky;top:48px;z-index:2;background:#6b2320;color:#fff;padding:10px 16px;font-size:13px;border-bottom:1px solid #8a2f2b}
    .banner a{color:#fff;font-weight:700;text-decoration:underline}
    .panel{position:sticky;top:48px;z-index:1;background:#11161c;border-bottom:1px solid #222a34;padding:14px 16px 16px;display:grid;gap:12px;max-width:100%}
    .panel-t{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6f7986}
    .fld{display:grid;grid-template-columns:90px 1fr;gap:4px 14px;align-items:center;max-width:820px}
    .fld-l{color:#8a93a0;font-size:12px}
    .fld-h{grid-column:2;color:#5e6875;font-size:11.5px}
    .row-ctl.wide{flex-wrap:nowrap}
    .row-ctl.wide input{flex:1;min-width:200px}
    .fld input[type=text],.fld input[type=password]{all:unset;width:100%;max-width:560px;height:30px;padding:0 10px;border-radius:6px;border:1px solid #2a3340;background:#0e1114;color:#e6e4dd;font:12.5px ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
    .fld select{all:unset;height:30px;padding:0 10px;border-radius:6px;border:1px solid #2a3340;background:#0e1114;color:#e6e4dd;font-size:12.5px;cursor:pointer}
    .chk{display:flex;align-items:center;gap:8px;color:#c7cdd6;font-size:12.5px;cursor:pointer}
    .chk input{all:unset;width:14px;height:14px;border-radius:3px;border:1px solid #3a4454;background:#0e1114;display:inline-block;position:relative;cursor:pointer}
    .chk input:checked{background:#2f9e63;border-color:#2f9e63}
    .chk input:checked::after{content:"";position:absolute;left:4px;top:1px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}
    .row-ctl{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
    .stack{display:grid;gap:6px}
    .toggle{display:flex;align-items:center;gap:6px;color:#8a93a0;font-size:12px;white-space:nowrap;cursor:pointer;user-select:none}
    .toggle input{all:unset;width:28px;height:16px;border-radius:999px;background:#2a3340;position:relative;transition:background .15s;cursor:pointer}
    .toggle input::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#8a93a0;transition:left .15s,background .15s}
    .toggle input:checked{background:#2f9e63}
    .toggle input:checked::after{left:14px;background:#fff}
    .list,.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(520px,1fr));gap:8px;align-content:start}
    @media (max-width:600px){.list,.grid{grid-template-columns:1fr}}
    .list{padding:14px 16px 40px}
    .grid{grid-column:1/-1}
    .section{grid-column:1/-1;display:flex;align-items:baseline;gap:8px;color:#6f7986;font-size:11px;letter-spacing:.08em;text-transform:uppercase;margin:6px 0 2px}
    .section span{color:#4c5663}
    .empty{grid-column:1/-1;color:#6f7986;padding:28px 0;font-size:13px}
    .row{display:grid;grid-template-columns:40px 1fr auto;gap:12px;align-items:center;padding:10px 12px 10px 10px;min-width:0;
      border-radius:8px;background:#141920;border:1px solid #1d2531;border-left:3px solid #3a4454}
    .row.clean{border-left-color:#2f9e63}
    .row.light{border-left-color:#c9a227}
    .row.moderate{border-left-color:#e07b2a}
    .row.severe{border-left-color:#d6453d;background:#1a1416}
    .row.pending{opacity:.65}
    .pic{width:40px;height:40px;border-radius:6px;background:#1f2733;object-fit:cover;display:flex;align-items:center;justify-content:center;
      color:#8a93a0;font-weight:700;font-size:16px}
    .main{min-width:0}
    .line{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;min-width:0}
    .name{font-weight:600;font-size:14px;color:#f2f1ec;text-decoration:none}
    .name:hover{text-decoration:underline}
    .rep{font-size:12px;color:#8a93a0}
    .row.clean .rep{color:#4fb57f}
    .row.light .rep{color:#d7b545}
    .row.moderate .rep{color:#eb9150}
    .row.severe .rep{color:#ef6b63;font-weight:600}
    .meta{display:flex;flex-wrap:wrap;gap:4px 6px;margin-top:5px;align-items:center;min-width:0}
    .social{overflow:hidden;text-overflow:ellipsis;max-width:100%}
    .tag{font-size:11px;line-height:18px;height:18px;padding:0 7px;border-radius:4px;background:#1f2733;color:#aeb7c2;white-space:nowrap}
    .tag.amber{background:#3a2d12;color:#e6b85c}
    .tag.green{background:#143426;color:#6fcf97}
    .tag.red{background:#44201e;color:#f08a84}
    .tag.live{background:#9146ff;color:#fff;font-weight:600;text-decoration:none}
    .tag.live:hover{background:#a970ff}
    .social{font-size:11px;color:#8a93a0;white-space:nowrap;display:inline-flex;gap:8px;align-items:center}
    .soc{display:inline-flex;align-items:center;gap:4px;color:#8a93a0;text-decoration:none}
    a.soc{color:#aeb7c2}
    a.soc:hover{color:#fff}
    .pbadge{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 3px;border-radius:4px;font-size:9.5px;font-weight:700;letter-spacing:.02em;color:#fff;background:#3a4454}
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
    .side{text-align:right;font-size:11.5px;color:#6f7986;white-space:nowrap;line-height:1.5}
    .side .pres{color:#8a93a0}
    .side .pres.on{color:#4fb57f}
    .side .pres.sot{color:#7fb7ff}
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
  const RAW_URL = 'https://raw.githubusercontent.com/MrNickIE/sotrep-live/main/sotrep-live.user.js';
  const MY_VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '0';
  function cmpVersion(a, b) {
    const pa = String(a).split('.').map(n => parseInt(n, 10) || 0), pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
    return 0;
  }
  function checkForUpdate() {
    GM_xmlhttpRequest({
      method: 'GET', url: RAW_URL + '?t=' + Date.now(), timeout: 15000,
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
  let bannerEl = null;
  function showUpdateBanner(latest, installedFromLink) {
    if (!bannerEl) return;
    bannerEl.replaceChildren(
      latest
        ? h('span', {}, `Version ${latest} is out, you are on ${MY_VERSION}. `)
        : h('span', {}, 'This copy was pasted in by hand so it will never update. '),
      h('a', { href: RAW_URL, target: '_blank', rel: 'noopener' }, latest && installedFromLink ? 'Update now' : 'Install from the link instead'),
      latest && installedFromLink ? h('span', {}, ' (or Tampermonkey menu, Check for userscript updates)') : h('span', {}, ', then delete this copy in Tampermonkey.'),
    );
    bannerEl.style.display = '';
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
      session.live.set(login, { at: Date.now(), live: r.live, title: r.title || '', url: `https://www.twitch.tv/${login}`, error: r.error });
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

  let listEl, statusEl, nameBox, panelEl, versionEl;
  function setView(v) { session.setView(v); }

  function buildAlertsPanel() {
    const a = state.alerts;
    const field = (label, control, hint) => h('div', { class: 'fld' }, h('div', { class: 'fld-l' }, label), control, hint ? h('div', { class: 'fld-h' }, hint) : null);
    const check = (key, text) => {
      const c = h('input', { type: 'checkbox' }); c.checked = !!a[key];
      c.addEventListener('change', () => { a[key] = c.checked; save(); if (key === 'sound' && c.checked) ensureAudio(); });
      return h('label', { class: 'chk' }, c, text);
    };
    // masked like a password: a webhook URL is a posting credential for that channel
    const webhook = h('input', { type: 'password', placeholder: 'https://discord.com/api/webhooks/…', spellcheck: 'false', autocomplete: 'off' });
    webhook.value = a.discord || '';
    webhook.addEventListener('change', () => { a.discord = webhook.value.trim(); save(); });
    const showBtn = h('button', { class: 'btn quiet' }, 'Show');
    showBtn.addEventListener('click', () => { const hidden = webhook.type === 'password'; webhook.type = hidden ? 'text' : 'password'; showBtn.textContent = hidden ? 'Hide' : 'Show'; });
    const discordMsg = h('span', { class: 'fld-h', style: 'grid-column:auto' });
    const discordTest = h('button', { class: 'btn quiet' }, 'Test Discord');
    discordTest.addEventListener('click', async () => {
      a.discord = webhook.value.trim(); save();
      if (!a.discord) { discordMsg.textContent = 'No webhook URL'; return; }
      discordMsg.textContent = 'Sending…';
      const r = await postDiscord('TestPirate', { severe_count: 1, banned_xuids: ['test'], manual_tags: [{ tooltip: 'Test alert' }] }, 'severe', SOTREP);
      discordMsg.textContent = r.ok ? 'Posted to Discord' : r.error;
    });
    const diagMsg = h('span', { class: 'fld-h', style: 'grid-column:auto' });
    const diagBtn = h('button', { class: 'btn quiet' }, 'Test sotrep');
    diagBtn.addEventListener('click', async () => {
      diagMsg.textContent = 'Asking sotrep.com…';
      const t0 = Date.now();
      const r = await sotrepSearchAs('BigMephobia', 'xbox');
      const ms = Date.now() - t0;
      diagMsg.textContent = r.error ? `${ms} ms: ${r.error}` : `${ms} ms: ok, signed in${r.gamertag ? ' (found ' + r.gamertag + ')' : ''}`;
    });
    const soundTest = h('button', { class: 'btn quiet' }, 'Test sound');
    soundTest.addEventListener('click', () => playChime('severe'));
    const twBox = h('input', { type: 'text', placeholder: 'twitch channel name', spellcheck: 'false', autocomplete: 'off', style: 'max-width:220px' });
    const twMsg = h('span', { class: 'fld-h', style: 'grid-column:auto' });
    const twTest = h('button', { class: 'btn quiet' }, 'Check Twitch');
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

    const testMsg = h('div', { class: 'fld-h' });
    const fakeRep = { severe_count: 1, banned_xuids: ['test'], manual_tags: [{ tooltip: 'Test alert' }], profile_id: null };
    const testAll = h('button', { class: 'btn' }, 'Test alerts');
    testAll.addEventListener('click', async () => {
      testMsg.textContent = 'Testing…';
      const parts = [];
      if (a.sound) { playChime('severe'); parts.push('sound played'); }
      if (a.desktop) { desktopNotify('TestPirate', fakeRep); parts.push('desktop sent'); }
      if (a.discord) { const r = await postDiscord('TestPirate', fakeRep, 'severe', SOTREP); parts.push(r.ok ? 'Discord ok' : 'Discord: ' + r.error); }
      testMsg.textContent = parts.length ? parts.join(' · ') : 'Nothing enabled';
    });
    const desktopBtn = h('button', { class: 'btn quiet' }, 'Allow desktop notifications');
    desktopBtn.addEventListener('click', async () => {
      try { const p = await Notification.requestPermission(); testMsg.textContent = 'Desktop notifications: ' + p; } catch (e) { testMsg.textContent = 'Not available in this browser'; }
    });

    panelEl = h('div', { class: 'panel', style: 'display:none' },
      h('div', { class: 'panel-t' }, 'Alerts'),
      field('Alert on', h('div', { class: 'stack' },
        check('severe', 'Red: severe flags or banned accounts'),
        check('moderate', 'Orange: moderate flags'),
        check('streamers', 'Purple: streamer with a linked Twitch channel who is live right now'),
      ), 'Any mix. Untick the first two for a Twitch-only watch. Streamers are checked against Twitch when they appear and every 5 minutes while on the Recent board; offline streamers just show their Twitch link.'),
      field('', h('div', { class: 'row-ctl' }, twBox, twTest, twMsg), 'Type any Twitch channel to test the live check. A live one also fires the streamer alert.'),
      field('Sound', h('div', { class: 'row-ctl' }, check('sound', 'Play a chime in this tab (works with the game in front, no permissions needed)'), soundTest)),
      field('Discord', h('div', { class: 'row-ctl wide' }, webhook, showBtn, discordTest, discordMsg), 'Paste a webhook URL for a private channel. Flagged players get posted there with the rep and a profile link.'),
      field('Desktop', h('div', { class: 'row-ctl' }, check('desktop', 'Windows notification'), desktopBtn), 'Hidden behind a full-screen game; useful on a second screen only.'),
      h('div', { class: 'row-ctl' }, testAll, testMsg),
      field('Connection', h('div', { class: 'row-ctl' }, diagBtn, diagMsg), 'One lookup against sotrep.com with the result and timing, for when rows sit on "queued" or show refusals.'),
    );
    return panelEl;
  }
  function buildUI() {
    const host = document.createElement('div');
    host.id = 'sotrep-live-host';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.append(h('style', { html: css }));

    statusEl = h('span', { class: 'status' }, h('span', { class: 'dot' }), 'Starting…');

    nameBox = h('input', { type: 'text', placeholder: 'Check a gamertag', spellcheck: 'false', autocomplete: 'off' });
    nameBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') checkName(); });

    const alertsBtn = h('button', { class: 'btn quiet', title: 'Alert settings' }, 'Alerts');
    alertsBtn.addEventListener('click', () => {
      const open = panelEl.style.display !== 'none';
      panelEl.style.display = open ? 'none' : '';
      alertsBtn.classList.toggle('on', !open);
    });

    const tabRecent = h('button', { class: 'tab on', onclick: () => setView('recent') }, 'Recent');
    const tabHistory = h('button', { class: 'tab', onclick: () => setView('history') }, 'History');
    session.setView = (v) => { session.view = v; tabRecent.classList.toggle('on', v === 'recent'); tabHistory.classList.toggle('on', v === 'history'); render(); };

    versionEl = h('a', { class: 'ver', href: RAW_URL, target: '_blank', rel: 'noopener', title: 'Click to update or reinstall through Tampermonkey' }, 'v' + MY_VERSION);
    const bar = h('div', { class: 'bar' },
      h('div', { class: 'brand' }, 'SOTREP ', h('b', {}, 'Live'), versionEl),
      h('div', { class: 'tabs' }, tabRecent, tabHistory),
      statusEl,
      h('div', { class: 'search' }, nameBox, h('button', { onclick: checkName }, 'Check')),
      alertsBtn,
      h('button', { class: 'btn quiet', onclick: clearSession, title: 'Clear the Recent board. Names stay remembered so they are not treated as new again.' }, 'Clear'),
      twoPress('Reset', 'Really reset?', 'btn quiet', resetAll, 'Forget all remembered names and cached lookups and re-baseline. Press twice.'),
    );
    listEl = h('div', { class: 'list' });
    bannerEl = h('div', { class: 'banner', style: 'display:none' });
    const root = h('div', { class: 'root' }, bar, bannerEl, buildAlertsPanel(), listEl);
    // any click on the board counts as the user gesture Chrome wants before a tab may play audio
    root.addEventListener('click', ensureAudio, { once: true });
    shadow.append(root);
    document.body.append(host);
    document.title = 'SOTREP Live';
    render();
  }

  function setStatus(txt, err) {
    statusEl.replaceChildren(h('span', { class: 'dot' + (err ? ' err' : '') }), txt);
  }
  function statusLine() {
    const t = session.lastPoll ? session.lastPoll.toLocaleTimeString('en-GB') : '…';
    const q = session.queue.length ? ` · ${session.queue.length} lookup${session.queue.length > 1 ? 's' : ''} queued` : '';
    return `${session.count} in Recently Met · checked ${t}${q}`;
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
    if (session.view === 'history') return renderHistory();
    if (!session.order.length) {
      listEl.append(h('div', { class: 'empty' }, state.baselined
        ? `Watching. ${Object.keys(state.seen).length} names remembered; new encounters appear here as the game registers them. History shows everyone seen so far.`
        : 'Taking baseline…'));
      return;
    }
    listEl.append(h('div', { class: 'section' }, 'Recent encounters', h('span', {}, session.order.length)));
    for (const gt of session.order) listEl.append(renderRow(gt, false));
  }

  function renderHistory() {
    const base = baselineStamp();
    const all = Object.entries(state.seen).sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]));
    const tracked = all.filter(([, iso]) => iso !== base);
    const baseline = all.filter(([, iso]) => iso === base);
    if (!tracked.length && !baseline.length) { listEl.append(h('div', { class: 'empty' }, 'Nothing recorded yet.')); return; }
    let lastDay = null;
    for (const [gt, iso] of tracked) {
      const day = dayLabel(new Date(iso));
      if (day !== lastDay) { listEl.append(h('div', { class: 'section' }, day)); lastDay = day; }
      listEl.append(renderRow(gt, true));
    }
    if (baseline.length) {
      const body = h('div', { class: 'grid' });
      const fill = () => { body.replaceChildren(); for (const [gt] of baseline.sort((a, b) => a[0].localeCompare(b[0]))) body.append(renderRow(gt, true)); };
      const apply = () => { body.style.display = session.foldOpen ? '' : 'none'; head.querySelector('.hint').textContent = session.foldOpen ? 'hide' : 'show'; if (session.foldOpen) fill(); };
      const head = h('div', { class: 'section fold' }, `Met before tracking started`, h('span', {}, baseline.length), h('span', { class: 'hint' }, 'show'));
      head.addEventListener('click', () => { session.foldOpen = !session.foldOpen; apply(); });
      listEl.append(head, body);
      apply();   // the 20 s poll re-renders, so keep whatever state the fold was in
    }
  }

  function renderRow(gt, withLookupBtn) {
    {
      const cur = session.current.get(gt);
      const entry = state.cache[gt];
      const rep = entry && entry.rep;
      const cls = repClass(rep);
      const link = rep && rep.profile_id ? `${SOTREP}/search/${rep.profile_id}` : `${SOTREP}/`;

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
        else if (login && !lv) tags.push(h('span', { class: 'tag' }, 'checking Twitch…'));
        const soc = (rep.socials || []).filter(s => s && !s.hidden && s.platform && s.platform !== 'playfab');
        soc.forEach((s) => {
          const label = s.username || s.platform;
          const p = String(s.platform).toLowerCase();
          const badge = h('span', { class: 'pbadge ' + p, title: s.platform }, PLATFORM_LETTER[p] || p.charAt(0).toUpperCase());
          socials.push(s.link
            ? h('a', { class: 'soc', href: s.link, target: '_blank', rel: 'noopener', title: s.platform }, badge, label)
            : h('span', { class: 'soc', title: s.platform }, badge, label));
        });
      }

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
      const needsLookup = withLookupBtn && !entry && !queued;
      const repText = needsLookup ? 'not checked' : queued && !entry ? 'queued…' : repLabel(rep);

      return h('div', { class: 'row ' + (needsLookup ? 'unchecked' : cls) },
        pic ? h('img', { class: 'pic', src: pic, alt: '' }) : h('div', { class: 'pic' }, gt.trim().charAt(0).toUpperCase()),
        h('div', { class: 'main' },
          h('div', { class: 'line' },
            h('a', { class: 'name', href: link, target: '_blank', rel: 'noopener' }, gt),
            h('span', { class: 'rep' }, repText),
            needsLookup ? h('button', { class: 'mini', onclick: () => { session.manual.add(gt); enqueue(gt, true); render(); } }, 'Look up') : null,
            rep && rep.error ? h('button', { class: 'mini', onclick: () => { delete state.cache[gt]; save(); enqueue(gt, true); render(); } }, 'Retry') : null,
          ),
          (tags.length || socials.length) ? h('div', { class: 'meta' }, tags, socials.length ? h('span', { class: 'social' }, socials) : null) : null,
        ),
        h('div', { class: 'side', title: presence[2] },
          presence[1] ? h('div', { class: 'pres ' + presence[0] }, presence[1]) : null,
          first ? h('div', {}, (withLookupBtn ? '' : 'met ') + (withLookupBtn ? first.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : first.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))) : null,
        ),
      );
    }
  }

  // ---------- data: Recently Met ----------
  async function fetchRecent() {
    const r = await fetch(RECENT_URL, { headers: { Accept: 'application/json' } });
    if (r.status === 401 || r.status === 403) throw new Error('Not logged in to seaofthieves.com (reload and sign in)');
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) throw new Error('Unexpected reply from seaofthieves.com (session expired?)');
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error('Unexpected shape from get-recent-friends');
    return j;
  }

  async function poll() {
    try {
      const list = await fetchRecent();
      session.count = list.length;
      const now = new Date().toISOString();
      const fresh = [];
      const MISSING_POLLS = 2;   // a name must be gone this many polls before its return counts as meeting them again
      const present = {};
      for (const p of list) {
        if (!p || !p.Gamertag) continue;
        const gt = p.Gamertag;
        present[gt] = true;
        session.current.set(gt, p);
        if (!state.seen[gt]) {
          // never seen: a new encounter
          state.seen[gt] = now;
          if (state.baselined) fresh.push(gt);
        } else if (state.inList && !state.inList[gt] && (state.missing[gt] | 0) >= MISSING_POLLS) {
          // seen before, dropped off Rare's rolling list, now back: you met them again
          state.seen[gt] = now;
          delete state.cache[gt];   // rep may have changed since last time
          fresh.push(gt);
        }
        delete state.missing[gt];
      }
      // count how long each previously-listed name has been absent
      if (state.inList) for (const gt of Object.keys(state.inList)) if (!present[gt]) state.missing[gt] = (state.missing[gt] | 0) + 1;
      state.inList = present;
      if (!state.baselined) { state.baselined = true; state.baselineAt = now; }
      save();
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
      session.lastPoll = new Date();
      setStatus(statusLine());
      render();
    } catch (e) {
      setStatus('Problem: ' + (e.message || String(e)), true);
    }
  }

  // ---------- data: SOTREP ----------
  // Try as an Xbox gamertag first; if sotrep has no such player, try the same text as a Twitch channel name,
  // which resolves a streamer to their linked pirate.
  async function sotrepSearch(gamertag) {
    const xbox = await sotrepSearchAs(gamertag, 'xbox');
    if (!xbox.error || !/not found/i.test(xbox.error)) return xbox;
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
          if (res.status === 401) return resolve({ error: 'sign in to sotrep.com', pause: 120 });
          if (res.status === 403) {
            let d = {}; try { d = JSON.parse(res.responseText) || {}; } catch (e) {}
            if (d.require_captcha) return resolve({ error: 'sotrep.com wants a captcha: open sotrep.com, search any name there, then retry', pause: 300 });
            if (d.error === 'username_requirements_not_met') return resolve({ error: 'sotrep.com needs your account set up: open sotrep.com and finish sign-up', pause: 300 });
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

  const MAX_RECHECKS = 2;   // how many times to go back for a player sotrep is "still enriching"
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
    session.busy = true;
    while (session.queue.length) {
      // sotrep said stop (captcha, rate limit, not signed in): hold the whole queue until the pause is over
      if (session.pauseUntil && Date.now() < session.pauseUntil) {
        setStatus(`Lookups paused until ${new Date(session.pauseUntil).toLocaleTimeString('en-GB')} · ${session.pauseReason || 'sotrep.com asked us to wait'}`, true);
        await new Promise(r => setTimeout(r, Math.min(session.pauseUntil - Date.now(), 15000)));
        continue;
      }
      let gt = session.queue.shift();
      setStatus(statusLine());
      const rep = await sotrepSearch(gt);
      if (rep.pause) {
        session.pauseUntil = Date.now() + rep.pause * 1000;
        session.pauseReason = rep.error;
        session.queue.unshift(gt);        // put it back; it was not the player's fault
        render();
        continue;
      }
      // typed a Twitch name (or a differently-cased gamertag): carry on under the real gamertag
      if (!rep.error && rep.gamertag && rep.gamertag !== gt && !session.current.has(gt)) {
        const real = rep.gamertag;
        session.order = session.order.map(x => x === gt ? real : x).filter((x, i, a) => a.indexOf(x) === i);
        if (session.manual.has(gt)) session.manual.add(real);
        if (!state.seen[real]) state.seen[real] = state.seen[gt] || new Date().toISOString();
        delete state.seen[gt]; delete state.cache[gt];
        gt = real;
      }
      const prev = state.cache[gt];
      const rechecks = prev && prev.rep && prev.rep.enriching ? (prev.rechecks | 0) + 1 : 0;
      state.cache[gt] = { at: Date.now(), rep, rechecks, picRetried: !!(prev && prev.picRetried) };
      save();
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
    if (!state.seen[gt]) state.seen[gt] = new Date().toISOString();
    delete state.cache[gt];   // you asked by hand, so always fetch fresh
    save();
    enqueue(gt);
    render();
  }
  function clearSession() { session.order = []; session.queue = []; render(); setStatus(statusLine()); }
  function resetAll() {
    state.seen = {}; state.cache = {}; state.baselined = false; state.baselineAt = null; save();
    session.order = []; session.queue = [];
    poll();
  }

  // ---------- go ----------
  buildUI();
  poll();
  setInterval(poll, POLL_SECONDS * 1000);
  checkForUpdate();
  setInterval(checkForUpdate, 6 * 3600e3);
})();

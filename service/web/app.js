/* AI Workforce dashboard – live data from the local service. Plain JS, no build step, no inline handlers. */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var TOKEN = (document.querySelector('meta[name="aiw-token"]') || {}).content || new URLSearchParams(location.search).get('t') || '';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function safeUrl(u) { return /^https:\/\//i.test(String(u || '')) ? String(u) : ''; }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } return null; }

  var ICON = {
    home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    board: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/>',
    agents: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    plug: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>',
    ask: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    play: '<path d="M7 5l12 7-12 7z"/>',
    warn: '<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17.5v.01"/>',
    pr: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V10a3 3 0 0 0-3-3h-4"/><path d="M13 5l-2 2 2 2"/>'
  };
  function svg(n, w) { w = w || 17; return '<svg viewBox="0 0 24 24" width="' + w + '" height="' + w + '" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[n] + '</svg>'; }

  var VIEWS = [['overview', 'Overview', 'home'], ['tickets', 'Tickets', 'board'], ['agents', 'Agents', 'agents'], ['background', 'Background', 'clock'], ['connections', 'Connections', 'plug']];
  var PALETTE = ['#1E4FD8', '#7C3AED', '#0E7490', '#B45309', '#BE123C', '#15803D', '#4D7C0F', '#9D174D'];
  var LOGO = { jira: ['#1868DB', 'J'], github: ['#24292F', 'G'], figma: ['#A259FF', 'F'], teams: ['#5B5FC7', 'T'], 'teams-personal': ['#5B5FC7', 'T'], notion: ['#37352F', 'N'], slack: ['#4A154B', 'S'], model: ['#C2410C', 'M'] };

  var S = { data: null, agents: null, view: 'overview', drawerId: null, drawer: null, hidden: {}, live: false, newFeed: 0, dirty: false };
  try { S.hidden = JSON.parse(sessionStorage.getItem('aiw-later') || '{}') || {}; } catch (e) { S.hidden = {}; }

  // ------------------------------------------------------------------ helpers
  function colorFor(name) { var h = 0; for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0; return PALETTE[h % PALETTE.length]; }
  function abbr(label) { var w = String(label || '?').split(/\s+/); return (w.length > 1 ? w[0][0] + w[1][0] : String(label).slice(0, 2)).toUpperCase(); }
  function hhmm(iso) { if (!iso) return ''; var d = new Date(iso); if (isNaN(d)) return ''; var today = new Date().toDateString() === d.toDateString(); return today ? pad(d.getHours()) + ':' + pad(d.getMinutes()) : d.toLocaleDateString([], { weekday: 'short' }); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function ago(iso) {
    if (!iso) return '–'; var s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (isNaN(s)) return '–'; if (s < 0) return inT(iso); if (s < 10) return 'just now'; if (s < 60) return s + ' s ago';
    var m = Math.round(s / 60); if (m < 60) return m + ' min ago'; var h = Math.round(m / 60); if (h < 24) return h + ' h ago'; return Math.round(h / 24) + ' d ago';
  }
  function inT(iso) {
    if (!iso) return '–'; var s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
    if (isNaN(s)) return '–'; if (s <= 5) return 'due now'; if (s < 60) return 'in ' + s + ' s';
    var m = Math.round(s / 60); if (m < 60) return 'in ' + m + ' min'; var h = Math.round(m / 60); if (h < 24) return 'in ' + h + ' h'; return 'in ' + Math.round(h / 24) + ' d';
  }
  function ktok(n) { n = Number(n) || 0; return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n); }
  function nowT() { var d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  var toastT;
  function toast(m) { var e = $('#toast'); e.textContent = m; e.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { e.hidden = true; }, 3200); }

  function api(method, path, body) {
    return fetch(path, { method: method, headers: { 'Content-Type': 'application/json', 'X-AIW-Token': TOKEN }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('Request failed (' + r.status + ')')); return j; }); });
  }

  // ------------------------------------------------------------------ loading
  var refreshT = null, loading = false;
  function load() {
    if (loading) { S.dirty = true; return Promise.resolve(); }
    loading = true;
    return api('GET', '/api/overview').then(function (d) { setData(d); $('#errorBar').hidden = true; })
      .catch(function (e) { showError('Could not reach the service: ' + e.message); })
      .then(function () { loading = false; if (S.dirty) { S.dirty = false; scheduleRefresh(); } });
  }
  function scheduleRefresh(ms) { clearTimeout(refreshT); refreshT = setTimeout(function () { load(); if (S.view === 'agents') loadAgents(); if (S.drawerId) loadDrawer(S.drawerId, true); }, ms == null ? 600 : ms); }
  function loadAgents() { return api('GET', '/api/agents').then(function (a) { S.agents = a; if (S.view === 'agents') render(); }).catch(function () { /* shown on next refresh */ }); }
  function showError(m) { var e = $('#errorBar'); e.textContent = m; e.hidden = false; }
  function setData(d) {
    if (!d || d.error) { showError(d && d.error ? d.error : 'No data'); return; }
    S.data = d; render();
  }

  // ------------------------------------------------------------------ live stream
  var es = null;
  function connectStream() {
    if (!window.EventSource) return;
    try { es = new EventSource('/api/stream?t=' + encodeURIComponent(TOKEN)); } catch (e) { return; }
    es.addEventListener('open', function () { S.live = true; renderLive(); });
    es.addEventListener('error', function () { S.live = false; renderLive(); });
    es.addEventListener('snapshot', function (ev) { try { setData(JSON.parse(ev.data)); } catch (e) { /* ignore */ } });
    es.addEventListener('activity', function (ev) { try { onActivity(JSON.parse(ev.data)); } catch (e) { /* ignore */ } });
    es.addEventListener('feed', function (ev) { try { onFeed(JSON.parse(ev.data)); } catch (e) { /* ignore */ } });
    ['job', 'item', 'needs', 'connector', 'slots', 'timer'].forEach(function (k) {
      es.addEventListener(k, function (ev) {
        var p = null; try { p = JSON.parse(ev.data); } catch (e) { /* ignore */ }
        if (k === 'timer' && p && S.data) { updateTimer(p); return; }
        scheduleRefresh();
      });
    });
  }
  function onActivity(p) {
    if (!S.data || !p || !p.taskId) return;
    if (p.ended) { scheduleRefresh(); return; }
    var w = (S.data.working || []).filter(function (x) { return x.taskId === p.taskId; })[0];
    if (!w) { scheduleRefresh(); return; }
    if (p.line) w.line = p.line;
    if (p.progress != null) w.progress = p.progress;
    if (p.tokens != null) w.tokens = p.tokens;
    if (p.agent) w.agent = p.agent;
    softRender();
  }
  function onFeed(p) {
    if (!S.data || !p) return;
    S.data.feed = [{ at: p.at || new Date().toISOString(), tone: p.tone || 'work', text: p.text || '', ref: p.ref, self: p.self, fresh: true }].concat((S.data.feed || []).slice(0, 59));
    softRender();
  }
  function updateTimer(p) {
    var t = (S.data.timers || []).filter(function (x) { return x.name === p.name; })[0];
    if (!t) { scheduleRefresh(); return; }
    t.lastRun = p.lastRun; t.nextRun = p.nextRun; t.state = p.state; t.error = p.error;
    t.label = p.state === 'running' ? 'Running' : p.state === 'failed' ? 'Failed' : p.state === 'healthy' ? 'Healthy' : 'Scheduled';
    t.tone = p.state === 'running' ? 'work' : p.state === 'failed' ? 'bad' : p.state === 'healthy' ? 'ok' : 'wait';
    softRender();
  }
  /** Re-render unless the person is typing an answer or the tour is open. */
  function softRender() { if (document.querySelector('.need .answer') || tourOn) { S.dirty = true; return; } render(); }
  function renderLive() { var l = document.querySelectorAll('.live'); for (var i = 0; i < l.length; i++) { l[i].classList.toggle('off', !S.live); l[i].lastChild.textContent = S.live ? 'Live' : 'Reconnecting'; } }

  // ------------------------------------------------------------------ views
  function counts() {
    var d = S.data; if (!d) return {};
    var badConn = (d.connections || []).filter(function (c) { return c.tone === 'you' || c.tone === 'bad'; }).length;
    var active = 0; (d.board.stages || []).forEach(function (s) { if (s.key !== 'done') active += s.items.length; });
    return {
      overview: needs().length ? { n: needs().length, you: 1 } : null,
      tickets: { n: active },
      agents: { n: (d.working || []).length },
      background: { n: (d.timers || []).length },
      connections: badConn ? { n: badConn, you: 1 } : { n: '✓' }
    };
  }
  function needs() { return S.data ? (S.data.needs || []).filter(function (n) { return !S.hidden[n.id]; }) : []; }

  function renderNav() {
    var c = counts();
    $('#nav').innerHTML = VIEWS.map(function (v) { var k = v[0]; return '<a href="#' + k + '"' + (k === S.view ? ' aria-current="page"' : '') + '>' + svg(v[2]) + v[1] + (c[k] ? '<span class="count ' + (c[k].you ? 'you' : '') + '">' + c[k].n + '</span>' : '') + '</a>'; }).join('');
    $('#mnav').innerHTML = VIEWS.map(function (v) { return '<a href="#' + v[0] + '"' + (v[0] === S.view ? ' aria-current="page"' : '') + '>' + v[1] + '</a>'; }).join('');
  }

  function strip() {
    var d = S.data, t = d.top, svc = d.service, cn = t.connections;
    return '<section class="strip" id="strip" aria-label="At a glance">' +
      '<div class="stat"><span class="k">Service</span><span class="v"><span class="dot ' + (svc.paused ? 'you' : 'ok') + ' pulse"></span>' + (svc.paused ? 'Paused' : 'Running') + '</span><span class="s">' + esc([svc.uptime, svc.version ? 'v' + svc.version : ''].filter(Boolean).join(' · ')) + '</span></div>' +
      '<div class="stat you"><span class="k">Needs you</span><span class="v num">' + needs().length + '<small>' + (needs().length ? 'decisions waiting' : 'all clear') + '</small></span></div>' +
      '<div class="stat"><span class="k">Agents working</span><span class="v num">' + t.agentsBusy + '<small>of ' + t.slots + ' slots</small></span></div>' +
      '<div class="stat"><span class="k">Tickets in progress</span><span class="v num">' + t.inProgress + '<small>' + t.waiting + ' waiting</small></span></div>' +
      '<div class="stat"><span class="k">Connections</span><span class="v">' + (cn.toCheck ? '<span class="dot you"></span>' + cn.ok + '/' + cn.total + '<small>' + cn.toCheck + ' to check</small>' : '<span class="dot ok"></span>All good') + '</span></div>' +
      '</section>';
  }

  function needsHtml() {
    var list = needs();
    if (!list.length) return '<div class="needs"><div class="empty">Nothing needs you right now. Agents will ask here and in Teams.</div></div>';
    return '<div class="needs">' + list.map(function (n) {
      var icon = n.kind === 'question' ? 'ask' : n.kind === 'start' ? 'play' : n.kind === 'problem' ? 'warn' : 'check';
      var opts = (n.options || []).map(function (o, i) {
        return '<button class="opt ' + (i === n.recommended ? 'rec' : '') + '" type="button" data-need="' + esc(n.id) + '" data-i="' + i + '">' + esc(o.label) + (i === n.recommended && n.kind === 'question' ? ' (recommended)' : '') + '</button>';
      }).join('');
      if (n.freeText) opts += '<button class="opt" type="button" data-need="' + esc(n.id) + '" data-i="free">' + (n.options && n.options.length ? 'Something else' : 'Answer') + '</button>';
      return '<div class="need" data-need-row="' + esc(n.id) + '"><div class="ic">' + svg(icon, 18) + '</div>' +
        '<div style="min-width:0"><div class="t"><button class="link mono" type="button" data-open="' + esc(n.taskId) + '">' + esc(n.ref) + '</button> · ' + esc(n.title) + '</div><div class="d">' + esc(n.detail) + '</div></div>' +
        '<div class="acts">' + opts + '</div></div>';
    }).join('') + '</div>';
  }

  function agentCard(w) {
    var col = colorFor(w.agent || w.agentLabel);
    return '<button class="agent" type="button" data-open="' + esc(w.taskId) + '">' +
      '<div class="hd"><div class="av" style="background:' + col + '1f;color:' + col + '">' + esc(abbr(w.agentLabel)) + '</div><div style="min-width:0"><div class="who">' + esc(w.agentLabel) + '</div><div class="on"><span class="mono">' + esc(w.ref) + '</span> · ' + esc(w.repo) + '</div></div>' + (w.tier ? '<span class="tier">' + esc(w.tier) + '</span>' : '') + '</div>' +
      '<div class="doing">' + esc(w.line) + '</div>' +
      '<div class="bar"><i style="width:' + (Number(w.progress) || 0) + '%"></i></div>' +
      '<div class="ft"><span><span class="dot work pulse"></span>working</span><span class="num">' + (w.minutes || 0) + ' min</span><span class="num">' + ktok(w.tokens) + ' tokens</span></div></button>';
  }
  function workingHtml() {
    var w = S.data.working || [];
    return w.length ? '<div class="agents">' + w.map(agentCard).join('') + '</div>' : '<div class="empty">No agent is working right now.</div>';
  }

  function cardHtml(t) {
    var multi = t.parts && t.parts.length > 1;
    var showBars = multi || (t.stage !== 'done' && t.stage !== 'waiting');
    return '<button class="card s-' + esc(t.tone) + '" type="button" data-open="' + esc(t.id) + '">' +
      '<div class="r1"><span class="ref">' + esc(t.ref) + '</span><span class="chip ' + esc(t.tone) + '">' + esc(t.label) + '</span>' + (t.size ? '<span class="tier sz">' + esc(t.size) + '</span>' : '') + '</div>' +
      '<div class="ttl">' + esc(t.title) + '</div>' +
      (t.stage !== 'done' ? '<div class="now">' + esc(t.now) + '</div>' : '') +
      (showBars ? '<div class="repos">' + t.parts.map(function (p) { return '<div class="repo ' + (p.pct >= 100 ? 'done' : '') + '"><span title="' + esc(p.repo) + '">' + esc(p.repo) + '</span><div class="bar"><i style="width:' + p.pct + '%"></i></div><span class="num">' + p.pct + '%</span></div>'; }).join('') + '</div>' : '') +
      (t.prs && t.prs.length ? '<div class="now">' + svg('pr', 13) + ' PR ' + esc(t.prs.map(function (p) { return p.label; }).join(', ')) + '</div>' : '') +
      '</button>';
  }
  function boardHtml() {
    return '<div class="board-scroll"><div class="board" id="board">' + S.data.board.stages.map(function (s) {
      return '<div class="lane"><h3><span>' + esc(s.label) + '</span><span class="num">' + s.items.length + '</span></h3>' + (s.items.map(cardHtml).join('') || '<div class="none">Empty</div>') + '</div>';
    }).join('') + '</div></div>';
  }

  function feedHtml() {
    var f = S.data.feed || [];
    return '<section class="panel" id="feedPanel"><div class="panel-h"><h2>Activity</h2><span class="sp"></span><span class="live' + (S.live ? '' : ' off') + '"><span class="dot ok pulse"></span><span>' + (S.live ? 'Live' : 'Reconnecting') + '</span></span></div>' +
      (f.length ? '<ul class="feed" id="feed">' + f.map(function (x) {
        var html = '<li class="' + (x.fresh ? 'new' : '') + '"><time>' + esc(hhmm(x.at)) + '</time><span class="dot ' + esc(x.tone) + '"></span><span>' + esc(x.text) + (x.self ? '<span class="self">answered itself</span>' : '') + '</span></li>';
        x.fresh = false; return html;
      }).join('') + '</ul>' : '<div class="empty">Nothing has happened yet today.</div>') + '</section>';
  }

  function jobsHtml(full) {
    var all = S.data.timers || [], rows = full ? all : all.slice(0, 4);
    return '<section class="panel" id="jobsPanel"><div class="panel-h"><h2>Running in the background</h2><span class="sp"></span>' + (full || all.length <= 4 ? '' : '<button class="link" type="button" data-go="background">See all</button>') + '</div>' +
      (rows.length ? '<div class="tbl"><table><tr><th>Job</th><th>How often</th><th>Last run</th><th>Next</th><th></th></tr>' + rows.map(function (j) {
        return '<tr><td><b>' + esc(j.name) + '</b><span class="sub">' + esc(j.error ? j.error : j.detail) + '</span></td><td>' + esc(j.every) + '</td><td class="num">' + esc(ago(j.lastRun)) + '</td><td class="num">' + esc(j.nextRun ? inT(j.nextRun) : '–') + '</td><td><span class="chip ' + esc(j.tone) + '">' + esc(j.label) + '</span></td></tr>';
      }).join('') + '</table></div>' : '<div class="empty">No background jobs have run yet.</div>') + '</section>';
  }

  function connsHtml() {
    return '<div class="conns" id="conns">' + (S.data.connections || []).map(function (c) {
      var lg = LOGO[c.provider] || ['#5D6575', c.name[0]];
      var cls = c.tone === 'you' ? 'warn' : c.label === 'Not connected' ? 'off' : '';
      var info = [['Account', c.account], ['Used for', c.usedFor], ['How', c.detail], ['Checked', c.checked ? ago(c.checked) : '']].filter(function (x) { return x[1]; });
      var act = '';
      if (c.action && c.action.href) act = '<a class="btn sm ' + (c.tone === 'you' || c.tone === 'bad' ? 'you' : '') + '" href="' + esc(c.action.href + '?t=' + encodeURIComponent(TOKEN)) + '">' + esc(c.action.label) + '</a>';
      else if (c.action && c.action.hint) act = '<div class="hint">' + esc(c.action.hint) + '</div>';
      return '<div class="conn ' + cls + '"><div class="hd"><div class="logo" style="background:' + lg[0] + '">' + esc(lg[1]) + '</div><div class="name">' + esc(c.name) + '</div><span class="chip ' + esc(c.tone) + '">' + esc(c.label) + '</span></div>' +
        '<dl>' + info.map(function (x) { return '<dt>' + esc(x[0]) + '</dt><dd>' + esc(x[1]) + '</dd>'; }).join('') + '</dl>' + act + '</div>';
    }).join('') + '</div>';
  }

  function ticketsTable() {
    var all = []; S.data.board.stages.forEach(function (s) { s.items.forEach(function (t) { all.push([s.label, t]); }); });
    if (!all.length) return '<section class="panel"><div class="panel-h"><h2>All tickets</h2></div><div class="empty">No tickets yet.</div></section>';
    return '<section class="panel"><div class="panel-h"><h2>All tickets</h2></div><div class="tbl"><table><tr><th>Ticket</th><th>Stage</th><th>Status</th><th>Repos</th><th>Tokens</th><th>Cost</th><th>PR</th></tr>' +
      all.map(function (x) { var t = x[1]; return '<tr data-open="' + esc(t.id) + '"><td><span class="mono">' + esc(t.ref) + '</span><span class="sub">' + esc(t.title) + '</span></td><td>' + esc(x[0]) + '</td><td><span class="chip ' + esc(t.tone) + '">' + esc(t.label) + '</span></td><td>' + esc(t.parts.map(function (p) { return p.repo; }).join(' + ')) + '</td><td class="num">' + (t.tokens ? ktok(t.tokens) : '–') + '</td><td class="num">' + (t.cost ? '$' + Number(t.cost).toFixed(2) : '–') + '</td><td>' + esc(t.prs.map(function (p) { return p.label; }).join(', ')) + '</td></tr>'; }).join('') +
      '</table></div></section>';
  }

  function agentsView() {
    var a = S.agents;
    if (!a) { loadAgents(); return '<div class="empty">Loading…</div>'; }
    return '<div class="col"><div class="banner">' + svg('agents') + '<span><b>' + a.slots.total + ' slots</b> run at the same time. At most ' + a.slots.perRepo + ' builds per repository. Planning only reads code, so it never waits for a repository.</span></div>' +
      '<section><div class="sec-h"><h2>Working now</h2><p>' + a.slots.used + ' of ' + a.slots.total + ' slots in use</p></div>' + (a.busy.length ? '<div class="agents">' + a.busy.map(agentCard).join('') + '</div>' : '<div class="empty">No agent is working right now.</div>') + '</section>' +
      '<section><div class="sec-h"><h2>Ready</h2><p>Start when a ticket needs them</p></div><div class="agents">' + a.ready.map(function (r) {
        var col = colorFor(r.agent);
        return '<div class="agent idle"><div class="hd"><div class="av" style="background:' + col + '1f;color:' + col + '">' + esc(abbr(r.label)) + '</div><div><div class="who">' + esc(r.label) + '</div><div class="on">Idle</div></div>' + (r.tier ? '<span class="tier">' + esc(r.tier) + '</span>' : '') + '</div><div class="doing muted">' + esc(r.what) + '</div></div>';
      }).join('') + '</div></section>' +
      '<section class="panel"><div class="panel-h"><h2>Queue</h2><span class="sp"></span><span class="muted" style="font-size:13px">Starts in this order when a slot frees</span></div>' +
      (a.queue.length ? '<div class="tbl"><table><tr><th>#</th><th>Ticket</th><th>Why it waits</th></tr>' + a.queue.map(function (q) {
        return '<tr data-open="' + esc(q.taskId) + '"><td>' + q.pos + '</td><td><span class="mono">' + esc(q.ref) + '</span><span class="sub">' + esc(q.title) + '</span></td><td><span class="chip ' + esc(q.tone) + '">' + esc(q.why) + '</span></td></tr>';
      }).join('') + '</table></div>' : '<div class="empty">Nothing is waiting.</div>') + '</section></div>';
  }

  function render() {
    renderNav();
    var d = S.data;
    $('#viewTitle').textContent = VIEWS.filter(function (v) { return v[0] === S.view; })[0][1];
    $('#clock').textContent = 'Updated ' + nowT();
    if (!d) return;
    $('#mockBadge').hidden = !d.service.mock;
    $('#pausedBar').hidden = !d.service.paused;
    $('#pauseBtn span').textContent = d.service.paused ? 'Resume new work' : 'Pause new work';
    $('#pauseBtnM').textContent = d.service.paused ? 'Resume' : 'Pause';
    var V = $('#view'), y = window.scrollY;
    if (S.view === 'overview') {
      V.innerHTML = '<div class="col">' + strip() +
        '<div class="grid"><div class="col">' +
        '<section id="needsSec"><div class="sec-h"><h2>Needs you</h2><p>Decide here or reply in Teams. Both work.</p></div>' + needsHtml() + '</section>' +
        '<section id="agentsSec"><div class="sec-h"><h2>Working now</h2><p>Click a card to see the ticket.</p><span class="sp"></span><button class="link" type="button" data-go="agents">All agents</button></div>' + workingHtml() + '</section>' +
        '<section id="boardSec"><div class="sec-h"><h2>Ticket progress</h2><p>Each ticket moves left to right.</p></div>' + boardHtml() + '</section>' +
        '</div><div class="col">' + feedHtml() + jobsHtml(false) + '</div></div></div>';
    } else if (S.view === 'tickets') {
      V.innerHTML = '<div class="col"><div class="banner">' + svg('board') + '<span><b>Tip:</b> click any ticket to see every step, who did it, and what it cost.</span></div>' + boardHtml() + ticketsTable() + '</div>';
    } else if (S.view === 'agents') {
      V.innerHTML = agentsView();
    } else if (S.view === 'background') {
      V.innerHTML = '<div class="col"><div class="banner">' + svg('clock') + '<span>These run by themselves. Most use <b>no AI at all</b>, so they cost nothing.</span></div>' + jobsHtml(true) + feedHtml() + '</div>';
    } else {
      V.innerHTML = '<div class="col"><div class="banner">' + svg('plug') + '<span>If a tool stops working you also get a short Teams message with a <b>Reconnect</b> link.</span></div>' + connsHtml() + '</div>';
    }
    window.scrollTo(0, y);
  }

  // ------------------------------------------------------------------ drawer
  function loadDrawer(id, quiet) {
    return api('GET', '/api/items/' + encodeURIComponent(id) + '/timeline').then(function (t) { if (S.drawerId !== id) return; S.drawer = t; drawDrawer(); })
      .catch(function (e) { if (!quiet) toast(e.message); });
  }
  function openTicket(id) {
    if (!id) return;
    S.drawerId = id; S.drawer = null;
    $('#drawer').innerHTML = '<div class="dh"><h2>Loading…</h2><button class="x" type="button" id="closeD" aria-label="Close">✕</button></div>';
    $('#drawer').hidden = false; $('#scrim').hidden = false; $('#closeD').focus();
    loadDrawer(id);
  }
  function drawDrawer() {
    var t = S.drawer; if (!t) return;
    var si = t.stageIndex;
    var acts = (t.actions || []).map(function (a, i) { return '<button class="btn ' + (a.primary ? 'primary' : '') + '" type="button" data-dact="' + i + '">' + esc(a.label) + '</button>'; }).join('');
    if (safeUrl(t.ticketUrl)) acts += '<a class="btn" href="' + esc(safeUrl(t.ticketUrl)) + '" target="_blank" rel="noopener noreferrer">Open in Jira</a>';
    (t.prs || []).forEach(function (p) { if (safeUrl(p.url)) acts += '<a class="btn" href="' + esc(safeUrl(p.url)) + '" target="_blank" rel="noopener noreferrer">Open PR ' + esc(p.label) + '</a>'; });
    var qs = (t.questions || []);
    $('#drawer').innerHTML = '<div class="dh"><div style="min-width:0"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="mono muted">' + esc(t.ref) + '</span><span class="chip ' + esc(t.tone) + '">' + esc(t.label) + '</span>' + (t.size ? '<span class="tier">size ' + esc(t.size) + '</span>' : '') + '</div><h2>' + esc(t.title || t.ref) + '</h2></div><button class="x" type="button" id="closeD" aria-label="Close">✕</button></div>' +
      '<div class="body">' +
      '<div class="nowbox"><b>Now:</b> ' + esc(t.now) + (t.waitingFor ? '<div class="sub">Waiting for ' + esc(t.waitingFor) + '</div>' : '') + (t.eta ? '<div class="sub">' + esc(t.eta) + '</div>' : '') + (t.agent ? '<div class="sub">Agent: ' + esc(t.agent) + '</div>' : '') + '</div>' +
      '<div><div class="lbl">Stage</div><div class="stages">' + t.stages.map(function (s, i) {
        return '<div><div class="bar' + (i < si ? ' okbar' : '') + '"><i style="width:' + (i < si ? 100 : i === si ? 50 : 0) + '%"></i></div><div class="sl' + (i <= si ? ' on' : '') + '">' + esc(s.label) + '</div></div>';
      }).join('') + '</div></div>' +
      (t.parts && t.parts.length > 1 ? '<div><div class="lbl">Repositories</div><div class="repos">' + t.parts.map(function (p) { return '<div class="repo ' + (p.pct >= 100 ? 'done' : '') + '" style="grid-template-columns:110px 1fr 40px;font-size:13px"><span>' + esc(p.repo) + '</span><div class="bar"><i style="width:' + p.pct + '%"></i></div><span class="num">' + p.pct + '%</span></div>'; }).join('') + '</div></div>' : '') +
      (qs.length ? '<div><div class="lbl">Open question' + (qs.length > 1 ? 's' : '') + '</div><div class="qa">' + qs.map(function (q) { return '<div><b>' + esc(q.question) + '</b>' + (q.options.length ? '<div class="muted">' + esc(q.options.join(' / ')) + '</div>' : '') + '</div>'; }).join('') + '</div></div>' : '') +
      (t.error ? '<div class="error-bar">' + esc(t.error) + '</div>' : '') +
      '<div><div class="lbl">What happened</div><ol class="tl">' + (t.timeline || []).map(function (e) {
        return '<li class="' + esc(e.mark) + '"><span class="m">' + (e.mark === 'done' ? '✓' : e.mark === 'ask' ? '?' : e.mark === 'bad' ? '!' : '') + '</span><div><div class="st">' + esc(e.title) + '</div>' + (e.who ? '<div class="who">' + esc(e.who) + '</div>' : '') + '</div><time>' + esc(hhmm(e.at)) + '</time></li>';
      }).join('') + '</ol></div>' +
      '<div class="kv"><div><span>Tokens</span><b class="num">' + ktok(t.tokens) + '</b></div><div><span>Cost</span><b class="num">$' + Number(t.cost || 0).toFixed(2) + '</b></div><div><span>PR</span><b>' + esc((t.prs || []).map(function (p) { return p.label; }).join(', ') || '–') + '</b></div></div>' +
      '</div>' + (acts ? '<div class="dacts">' + acts + '</div>' : '');
  }
  function closeDrawer() { $('#drawer').hidden = true; $('#scrim').hidden = true; S.drawerId = null; S.drawer = null; }

  // ------------------------------------------------------------------ actions
  function runAction(a, text, btn) {
    if (a.local) return Promise.resolve();
    var body = Object.assign({}, a.body || {});
    if (a.ask) { if (!text) { toast('Please write what should change.'); return Promise.reject(new Error('empty')); } body.reason = text; }
    if (text != null && a.path === '/api/answer') body.answer = text;
    if (btn) btn.disabled = true;
    return api(a.method, a.path, body).then(function (r) {
      var ok = r.ok !== false;
      toast(r.message ? stripMd(r.message) : ok ? 'Done.' : 'That did not work.');
      scheduleRefresh(150);
      return ok;
    }).catch(function (e) { toast(e.message); if (btn) btn.disabled = false; throw e; });
  }
  function stripMd(s) { return String(s).replace(/\*\*|`/g, ''); }
  function findNeed(id) { return (S.data && S.data.needs || []).filter(function (n) { return n.id === id; })[0]; }

  function openAnswer(row, need, action) {
    var old = row.querySelector('.answer'); if (old) old.remove();
    var div = document.createElement('div'); div.className = 'answer';
    div.innerHTML = '<textarea aria-label="' + esc(action.ask || 'Your answer') + '" placeholder="' + esc(action.ask || 'Your answer') + '"></textarea><button class="btn sm primary" type="button" data-send="1">Send</button><button class="btn sm" type="button" data-cancel="1">Cancel</button>';
    row.appendChild(div);
    var ta = div.querySelector('textarea'); ta.focus();
    div.querySelector('[data-cancel]').addEventListener('click', function () { div.remove(); if (S.dirty) { S.dirty = false; render(); } });
    div.querySelector('[data-send]').addEventListener('click', function (e) {
      var v = ta.value.trim(); if (!v) { ta.focus(); return; }
      runAction(action, v, e.currentTarget).then(function () { div.remove(); }).catch(function () { /* toast shown */ });
    });
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-need]');
    if (el) {
      var n = findNeed(el.getAttribute('data-need')); if (!n) return;
      var row = el.closest('.need');
      if (el.getAttribute('data-i') === 'free') { openAnswer(row, n, n.freeText); return; }
      var a = n.options[Number(el.getAttribute('data-i'))]; if (!a) return;
      if (a.local) { S.hidden[n.id] = 1; try { sessionStorage.setItem('aiw-later', JSON.stringify(S.hidden)); } catch (x) { /* ignore */ } toast(n.ref + ': I will keep it waiting.'); render(); return; }
      if (a.ask) { openAnswer(row, n, a); return; }
      runAction(a, a.path === '/api/answer' ? a.body.answer : null, el).catch(function () { /* shown */ });
      return;
    }
    var d = e.target.closest('[data-dact]');
    if (d && S.drawer) {
      var act = S.drawer.actions[Number(d.getAttribute('data-dact'))]; if (!act) return;
      if (act.ask) { var v = window.prompt(act.ask); if (v == null || !v.trim()) return; runAction(act, v.trim(), d).then(function () { loadDrawer(S.drawerId, true); }).catch(function () {}); }
      else runAction(act, null, d).then(function () { setTimeout(function () { if (S.drawerId) loadDrawer(S.drawerId, true); }, 400); }).catch(function () {});
      return;
    }
    var o = e.target.closest('[data-open]'); if (o) { openTicket(o.getAttribute('data-open')); return; }
    var g = e.target.closest('[data-go]'); if (g) { closeDrawer(); location.hash = g.getAttribute('data-go'); return; }
    if (e.target.closest('#closeD')) closeDrawer();
  });
  $('#scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeDrawer(); endTour(); } });

  function togglePause() {
    var paused = S.data && S.data.service.paused;
    api('POST', paused ? '/api/resume' : '/api/pause', {}).then(function () { toast(paused ? 'New work resumed.' : 'New work paused. Running tasks finish their current step.'); scheduleRefresh(100); }).catch(function (e) { toast(e.message); });
  }
  $('#pauseBtn').addEventListener('click', togglePause);
  $('#pauseBtnM').addEventListener('click', togglePause);
  $('#resumeBtn').addEventListener('click', togglePause);

  function applyTheme(t) { if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme'); }
  function switchTheme() {
    var r = document.documentElement, cur = r.getAttribute('data-theme');
    var dark = cur ? cur === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    var next = dark ? 'light' : 'dark'; applyTheme(next); store('aiw-theme', next);
  }
  applyTheme(store('aiw-theme'));
  $('#themeBtn').addEventListener('click', switchTheme);
  $('#themeBtnM').addEventListener('click', switchTheme);

  function route() {
    var h = location.hash.slice(1);
    S.view = VIEWS.some(function (v) { return v[0] === h; }) ? h : 'overview';
    closeDrawer(); if (S.view === 'agents') loadAgents(); render(); window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  // ------------------------------------------------------------------ tour
  var TOUR = [
    ['#strip', 'The top line', 'Service health, how many things need you, how many agents are busy, and whether every connection works. Look here first.'],
    ['#needsSec', 'Needs you', 'Questions, start requests and approvals. Click an option to decide. The recommended choice is outlined. The same items also come to Teams.'],
    ['#agentsSec', 'Working now', 'One card per busy agent: which ticket, what it is doing in plain words, progress, time and tokens. Click a card to open its ticket.'],
    ['#boardSec', 'Ticket progress', 'Every ticket moves from left to right. Tickets across two repositories show a bar per repository. The colour on the left edge tells you the state.'],
    ['#feedPanel', 'Activity', 'A live list of what just happened, newest first.'],
    ['#jobsPanel', 'Background jobs', 'Checks that run by themselves, like Jira, Teams and pull request watching. Open "Connections" in the menu to see each tool and reconnect it.']
  ];
  var tourOn = false, tStep = 0;
  function showTour() {
    var spots = document.querySelectorAll('.spot'); for (var i = 0; i < spots.length; i++) spots[i].classList.remove('spot');
    var step = TOUR[tStep], el = $(step[0]); if (!el) { endTour(); return; }
    el.classList.add('spot');
    el.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    var T = $('#tour'); T.hidden = false;
    T.innerHTML = '<div class="stepn">Step ' + (tStep + 1) + ' of ' + TOUR.length + '</div><h3>' + esc(step[1]) + '</h3><p>' + esc(step[2]) + '</p><div class="row"><button type="button" id="tSkip">Close</button><span class="sp"></span>' + (tStep ? '<button type="button" id="tBack">Back</button>' : '') + '<button class="go" type="button" id="tNext">' + (tStep === TOUR.length - 1 ? 'Done' : 'Next') + '</button></div>';
    setTimeout(function () {
      var r = el.getBoundingClientRect(), tw = T.offsetWidth, th = T.offsetHeight;
      var top = r.bottom + 14; if (top + th > innerHeight - 12) top = Math.max(12, r.top - th - 14); if (top < 12) top = 12;
      var left = Math.min(Math.max(16, r.left), innerWidth - tw - 16); T.style.top = top + 'px'; T.style.left = left + 'px';
    }, 350);
    $('#tSkip').addEventListener('click', endTour);
    $('#tNext').addEventListener('click', function () { if (tStep === TOUR.length - 1) endTour(); else { tStep++; showTour(); } });
    var b = $('#tBack'); if (b) b.addEventListener('click', function () { tStep--; showTour(); });
  }
  function startTour() { if (S.view !== 'overview') location.hash = 'overview'; tourOn = true; tStep = 0; setTimeout(showTour, 80); }
  function endTour() {
    if (!tourOn) return; tourOn = false; $('#tour').hidden = true;
    var spots = document.querySelectorAll('.spot'); for (var i = 0; i < spots.length; i++) spots[i].classList.remove('spot');
    store('aiw-tour-seen', '1'); if (S.dirty) { S.dirty = false; render(); }
  }
  $('#tourBtn').addEventListener('click', startTour);

  // ------------------------------------------------------------------ start
  $('#hostLbl').textContent = location.host;
  route();
  load().then(function () { if (!store('aiw-tour-seen') && S.data) startTour(); });
  connectStream();
  setInterval(function () { if (!S.live) load(); }, 30000);                     // no stream: refresh every 30 s
  setInterval(function () { $('#clock').textContent = 'Updated ' + nowT(); if (S.view === 'background' || S.view === 'overview') softRender(); }, 60000);
})();

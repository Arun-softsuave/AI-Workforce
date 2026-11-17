/** Local dashboard (single self-contained page, no external resources). */
const CSS = `
:root{--bg:#f6f8fb;--card:#fff;--text:#1e2430;--muted:#5a6472;--line:#dde3ec;--accent:#2f6fde;--navy:#14284b;--ok:#1f9d74;--warn:#c77a12;--bad:#b03a3a}
@media (prefers-color-scheme:dark){:root{--bg:#0f1520;--card:#18202d;--text:#e6ebf2;--muted:#9aa6b8;--line:#2a3445;--accent:#6a9cf5;--navy:#0b1220}}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,Segoe UI,Arial,sans-serif;background:var(--bg);color:var(--text)}
header{background:var(--navy);color:#fff;padding:14px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
header h1{font-size:17px;margin:0}header .s{color:#c7d5ee;font-size:12px}
nav{display:flex;gap:4px;padding:10px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
nav button{background:none;border:0;color:var(--muted);padding:6px 12px;border-radius:6px;cursor:pointer;font:inherit}
nav button.on{background:var(--accent);color:#fff}main{padding:16px;max-width:1100px;margin:auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-bottom:10px}
table{width:100%;border-collapse:collapse;background:var(--card)}td,th{padding:7px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600}.pill{font-size:11px;padding:2px 8px;border-radius:10px;background:var(--line);white-space:nowrap}
.AWAITING_APPROVAL,.NEEDS_INFO,.STALE,.AWAITING_START{background:#fcf2e3;color:#8a540b}.FAILED,.PAUSED,.FAILED_PUBLISH{background:#fbeded;color:#8f2b2b}
.DONE{background:#e7f6f0;color:#17775a}.RUNNING,.QUEUED{background:#eaf1fd;color:#1f55b5}
button.b{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit}button.r{background:var(--bad)}button.g{background:var(--muted)}
pre{white-space:pre-wrap;background:var(--bg);padding:10px;border-radius:6px;max-height:420px;overflow:auto;font-size:12.5px}
a{color:var(--accent)}.muted{color:var(--muted)}input,textarea,select{font:inherit;padding:7px;border:1px solid var(--line);border-radius:6px;width:100%;background:var(--card);color:var(--text)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.tbl{overflow-x:auto}`;

export function dashboardHtml(token: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Workforce</title><style>${CSS}</style></head><body>
<header><h1>AI Workforce</h1><span class="s" id="hdr">loading…</span><span style="flex:1"></span>
<button class="b g" onclick="act('POST','/api/poll').then(load)">Check now</button></header>
<nav id="nav"></nav><main id="main"></main>
<script>
const T=${JSON.stringify(token)};let tab='inbox';
const tabs={inbox:'Inbox',tasks:'Tasks',projects:'Projects & Brain',connections:'Connections',cost:'Cost'};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function act(m,p,b){const r=await fetch(p,{method:m,headers:{'Content-Type':'application/json','X-AIW-Token':T},body:b?JSON.stringify(b):undefined});const j=await r.json();if(!r.ok)alert(j.error||r.status);return j}
function nav(){document.getElementById('nav').innerHTML=Object.entries(tabs).map(([k,v])=>'<button class="'+(k==tab?'on':'')+'" onclick="tab=\\''+k+'\\';load()">'+v+'</button>').join('')}
async function load(){nav();const s=await act('GET','/api/status');
document.getElementById('hdr').textContent=(s.paused?'Paused · ':'Watching · ')+s.projects.length+' project(s) · last check '+(s.lastPoll?new Date(s.lastPoll.at).toLocaleTimeString():'never')+(s.provider==='mock'?' · OFFLINE MODEL (mock)':'');
const M=document.getElementById('main');
if(tab==='inbox'){const items=await act('GET','/api/inbox');M.innerHTML=items.length?items.map(i=>'<div class="card"><div class="row"><span class="pill">'+esc(i.kind)+'</span><b>'+esc(i.title)+'</b><span class="muted">'+new Date(i.at).toLocaleString()+'</span></div><div style="white-space:pre-wrap">'+esc(i.body)+'</div>'+(i.task?'<div class="row" style="margin-top:8px"><button class="b" onclick="show(\\''+i.task+'\\')">Open</button></div>':'')+'</div>').join(''):'<div class="card">Nothing needs your attention.</div>'}
if(tab==='tasks'){const ts=await act('GET','/api/tasks?limit=100');M.innerHTML='<div class="tbl"><table><tr><th>Ticket</th><th>Title</th><th>State</th><th>Size</th><th>Tokens</th><th>PR</th></tr>'+ts.reverse().map(t=>'<tr onclick="show(\\''+t.id+'\\')" style="cursor:pointer"><td>'+esc(t.ref)+'</td><td>'+esc(t.title)+'</td><td><span class="pill '+t.state+'">'+t.state+'</span></td><td>'+esc(t.size)+'</td><td>'+(t.tokens||0).toLocaleString()+'</td><td>'+(t.pr?'<a href="'+esc(t.pr)+'" target="_blank">PR</a>':'')+'</td></tr>').join('')+'</table></div>'}
if(tab==='projects'){M.innerHTML=s.projects.map(p=>'<div class="card"><b>'+esc(p.id)+'</b> <span class="muted">'+esc((p.jira||[]).join(','))+' · '+esc(p.repo||'')+' · '+esc(p.autonomy)+'</span><div class="row" style="margin:8px 0"><input id="q_'+p.id+'" placeholder="Ask the Brain…" style="flex:1"><button class="b" onclick="ask(\\''+p.id+'\\')">Ask</button><button class="b g" onclick="brain(\\''+p.id+'\\')">Summary</button></div><pre id="a_'+p.id+'" hidden></pre></div>').join('')||'<div class="card">No projects yet – run <code>aiw project add</code>.</div>'}
if(tab==='connections'){const all=['jira','github','slack','teams','notion','figma'];M.innerHTML='<div class="grid">'+all.map(p=>{const c=s.connections.find(x=>x.provider==p);return '<div class="card"><b>'+p+'</b><div class="muted">'+(c?esc(c.status+' · '+(c.account||'')):'not connected')+'</div><div class="row" style="margin-top:8px"><a class="b" style="padding:6px 12px;border-radius:6px;background:var(--accent);color:#fff;text-decoration:none" href="/connect/'+p+'?t='+encodeURIComponent(T)+'">'+(c?'Reconnect':'Connect')+'</a>'+(c?'<button class="b r" onclick="if(confirm(\\'Disconnect '+p+'?\\'))act(\\'DELETE\\',\\'/api/connect/'+p+'\\').then(load)">Disconnect</button>':'')+'</div></div>'}).join('')+'</div>'}
if(tab==='cost'){const c=await act('GET','/api/cost?days=7');const t=(rows,h)=>'<h3>'+h+'</h3><table><tr><th>Scope</th><th>Tasks</th><th>Tokens</th><th>Cost (USD)</th></tr>'+rows.map(r=>'<tr><td>'+esc(r.scope)+'</td><td>'+r.tasks+'</td><td>'+(r.tokens||0).toLocaleString()+'</td><td>'+(r.cost||0)+'</td></tr>').join('')+'</table>';M.innerHTML=t(c.byProject,'By project (7 days)')+t(c.byDay,'By day')+t(c.topTasks,'Most expensive tasks')}}
async function show(id){const d=await act('GET','/api/tasks/'+encodeURIComponent(id));const M=document.getElementById('main');
const ap=d.approval&&d.approval.state==='pending';
M.innerHTML='<div class="card"><div class="row"><b>'+esc(d.ref)+'</b><span class="pill '+d.state+'">'+d.state+'</span><span class="muted">'+esc(d.title)+'</span></div>'+
(d.ticketUrl?'<div><a href="'+esc(d.ticketUrl)+'" target="_blank">Ticket</a>'+(d.pr?' · <a href="'+esc(d.pr)+'" target="_blank">Pull request</a>':'')+'</div>':'')+
(d.error?'<p style="color:var(--bad)">'+esc(d.error)+'</p>':'')+(d.questions?'<p><b>Questions:</b> '+esc(d.questions.join(' / '))+'</p>':'')+
(ap?'<div class="row" style="margin:10px 0"><button class="b" onclick="decide(\\''+d.id+'\\',true)">Approve ('+esc(d.approval.action)+', commit '+esc(d.approval.head||'-')+')</button><input id="why" placeholder="Reason / feedback for rejection" style="flex:1"><button class="b r" onclick="decide(\\''+d.id+'\\',false)">Reject</button></div>':'')+
'<div class="row">'+['resume','refresh','start','cancel'].map(a=>'<button class="b g" onclick="act(\\'POST\\',\\'/api/tasks/'+d.id+'/'+a+'\\').then(()=>show(\\''+d.id+'\\'))">'+a+'</button>').join('')+'</div></div>'+
'<div class="card"><b>Steps</b><table><tr><th>Step</th><th>Status</th><th>Agents</th><th>Tokens</th><th>Note</th></tr>'+d.steps.map(s=>'<tr><td>'+esc(s.name)+'</td><td>'+esc(s.status)+'</td><td>'+esc(s.agent)+'</td><td>'+(s.tokens||0).toLocaleString()+'</td><td>'+esc(s.error||s.note||'')+'</td></tr>').join('')+'</table></div>'+
(d.report?'<div class="card"><b>Report</b><pre>'+esc(d.report)+'</pre></div>':'')+'<button class="b g" onclick="load()">Back</button>'}
async function decide(id,ok){const r=await act('POST','/api/'+(ok?'approve':'reject')+'/'+id,ok?{}:{reason:document.getElementById('why').value});alert(r.message);show(id)}
async function ask(p){const q=document.getElementById('q_'+p).value;const r=await act('POST','/api/brain/'+p+'/ask',{q});const e=document.getElementById('a_'+p);e.hidden=false;e.textContent=r.answer}
async function brain(p){const r=await act('GET','/api/brain/'+p);const e=document.getElementById('a_'+p);e.hidden=false;e.textContent=r.summary}
load();setInterval(()=>{if(['inbox','tasks'].includes(tab))load()},15000);
</script></body></html>`;
}

const FORMS: Record<string, { title: string; help: string; fields: [string, string, string][] }> = {
  jira: { title: "Connect Jira Cloud", help: "Create an API token at id.atlassian.com → Security → API tokens. The token is stored only in your OS credential vault.",
    fields: [["site", "Jira site", "yourcompany.atlassian.net"], ["email", "Atlassian account email", "you@company.com"], ["token", "API token", "password"]] },
  github: { title: "Connect GitHub", help: "Recommended instead: sign in to GitHub in the browser with a one-time code – run  aiw connect github  (no token). Fallback only: a fine-grained token limited to the selected repositories (Contents: read/write, Pull requests: read/write, Actions: read), or tick the box to reuse your existing `gh` login.",
    fields: [["token", "Personal access token (leave empty to use gh CLI)", "password"], ["fromGh", "Use my existing `gh auth login`", "checkbox"]] },
  slack: { title: "Connect Slack", help: "Create the app from the manifest (button below) at api.slack.com/apps → Create New App → From manifest, install it, then paste the Bot token (xoxb-…), an App-level token with connections:write (xapp-…) for Approve buttons, and your Slack member ID (Profile → ⋮ → Copy member ID).",
    fields: [["botToken", "Bot token (xoxb-…)", "password"], ["appToken", "App-level token (xapp-…) for buttons", "password"], ["userId", "Your Slack member ID", "U0123ABCD"], ["pendingAdmin", "My workspace admin must approve the app first", "checkbox"]] },
  teams: { title: "Connect Microsoft Teams", help: "In the target channel: ⋯ → Workflows → \"Post to a channel when a webhook request is received\". Copy the URL it gives you. Teams messages contain links; approvals happen in Claude Code, this dashboard or Slack.",
    fields: [["webhookUrl", "Workflows webhook URL", "password"]] },
  notion: { title: "Connect Notion", help: "Recommended instead: sign in with your Notion account in the browser – run  aiw connect notion  (no token). Fallback only: create an internal integration at notion.so/my-integrations, share the relevant pages with it and paste its token here.", fields: [["token", "Integration token", "password"]] },
  figma: { title: "Connect Figma", help: "Recommended instead: no token – open the Figma desktop app, enable its MCP server (Dev Mode → Enable desktop MCP server) and run  aiw connect figma.  Fallback only (reads files while the app is closed): create a personal access token in Figma → Settings → Security with File content: read-only and Current user: read.", fields: [["token", "Personal access token", "password"]] },
};

export function connectHtml(provider: string, token: string): string {
  const f = FORMS[provider];
  if (!f) return "<h1>Unknown connector</h1>";
  const inputs = f.fields.map(([name, label, ph]) => ph === "checkbox"
    ? `<label class="row" style="margin:8px 0"><input type="checkbox" name="${name}" style="width:auto"> ${label}</label>`
    : `<label>${label}<input name="${name}" ${ph === "password" ? 'type="password" autocomplete="off"' : `placeholder="${ph}"`}></label><br>`).join("");
  const manifest = provider === "slack" ? `<button type="button" class="b g" onclick="fetch('/api/slack-manifest',{headers:{'X-AIW-Token':T}}).then(r=>r.json()).then(j=>{navigator.clipboard.writeText(JSON.stringify(j,null,2));alert('Manifest copied to clipboard')})">Copy Slack app manifest</button>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${f.title}</title><style>${CSS}</style></head><body>
<header><h1>${f.title}</h1></header><main><div class="card"><p class="muted">${f.help}</p>
<form id="f">${inputs}<div class="row"><button class="b">Test & save</button>${manifest}<a href="/?t=${encodeURIComponent(token)}">Back to dashboard</a></div></form><pre id="out" hidden></pre></div></main>
<script>const T=${JSON.stringify(token)};document.getElementById('f').onsubmit=async e=>{e.preventDefault();const fd=new FormData(e.target);const b={};
for(const [k,v] of fd.entries())b[k]=v==='on'?true:v;for(const k of Object.keys(b))if(b[k]==='')delete b[k];
const r=await fetch('/api/connect/${provider}',{method:'POST',headers:{'Content-Type':'application/json','X-AIW-Token':T},body:JSON.stringify(b)});const j=await r.json();
const o=document.getElementById('out');o.hidden=false;o.textContent=j.ok?'Connected '+(j.account||'')+(j.detail?' – '+j.detail:''):'Failed: '+(j.detail||j.error);if(j.ok)e.target.reset()}</script></body></html>`;
}

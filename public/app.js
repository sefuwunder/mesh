// app.js — mesh dashboard (zero dependencies).
"use strict";
const app = document.getElementById("app");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = id => id ? id.slice(0, 8) + "…" + id.slice(-4) : "";
async function api(path, opts) {
  const r = await fetch(path, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
  return d;
}
let toastT;
function toast(m) {
  let t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = m; t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2600);
}
const ago = ts => {
  if (!ts) return "never";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  return Math.floor(s / 3600) + "h ago";
};

async function render() {
  const [st, peers, blobs, kv, log] = await Promise.all([
    api("/api/status"), api("/api/peers"), api("/api/blobs"), api("/api/kv"), api("/api/log?limit=15"),
  ]);
  app.innerHTML = `
    <h1>mesh</h1>
    <p class="sub">peer-to-peer storage node · gossiping over HTTPS</p>

    <div class="card"><h2>This node</h2>
      <dl class="kv-grid">
        <dt>peer id</dt><dd class="mono">${esc(st.id)}</dd>
        <dt>public url</dt><dd class="mono">${esc(st.url)}</dd>
        <dt>stored</dt><dd>${st.blobs} blobs · ${st.kvEntries} kv · ${st.logEntries} log entries</dd>
        <dt>peers</dt><dd>${st.peers}</dd>
      </dl>
      <div class="row">
        <button class="btn btn-primary" id="mk-invite">Create invite code</button>
        <button class="btn" id="sync-now">Sync now</button>
      </div>
      <div class="row" id="invite-out" style="display:none">
        <input class="invite-code mono" id="invite-code" readonly>
        <button class="btn" id="copy-invite">Copy</button>
      </div>
      <p class="hint">Run this node behind <span class="mono">cloudflared tunnel --url http://localhost:${location.port || 3014}</span>,
      set <span class="mono">PUBLIC_URL</span> to the tunnel hostname, then share the invite code.</p>
    </div>

    <div class="card"><h2>Peers</h2>
      ${peers.peers.length ? `<table><tr><th>id</th><th>url</th><th>seen</th><th></th></tr>
        ${peers.peers.map(p => `<tr><td class="mono">${esc(short(p.id))}</td>
          <td class="mono">${esc(p.url)}</td>
          <td>${p.last_seen ? `<span class="${p.last_ok ? "ok" : "bad"}">${esc(ago(p.last_seen))}</span>` : "never"}</td>
          <td><button class="btn btn-danger" data-unpeer="${esc(p.id)}" style="padding:4px 12px;font-size:12px">remove</button></td></tr>`).join("")}
        </table>` : `<p class="hint">No peers yet. Paste an invite code below.</p>`}
      <div class="row">
        <input id="join-code" class="mono" placeholder="paste invite code…" style="flex:1;min-width:200px">
        <button class="btn btn-primary" id="join">Join</button>
      </div>
    </div>

    <div class="card"><h2>Blobs <span class="pill">${blobs.blobs.length}</span></h2>
      <div class="row">
        <input type="file" id="blob-file" style="flex:1;min-width:200px">
        <button class="btn btn-primary" id="blob-put">Store</button>
      </div>
      ${blobs.blobs.slice(0, 20).map(b => `<table><tr><td class="mono">${esc(b.hash.slice(0, 20))}…</td>
        <td>${(b.size / 1024).toFixed(1)} KB</td>
        <td><button class="btn" data-pin="${esc(b.hash)}" data-pinned="${b.pinned ? 1 : 0}"
          style="padding:4px 12px;font-size:12px">${b.pinned ? "unpin" : "pin"}</button></td>
        <td><a class="mono" href="/api/blobs/${esc(b.hash)}" download>↓</a></td></tr></table>`).join("")}
      <p class="hint">Pinned blobs replicate to every peer that syncs with you.</p>
    </div>

    <div class="card"><h2>Key–value</h2>
      <div class="row">
        <input id="kv-k" placeholder="key" style="flex:1;min-width:120px">
        <input id="kv-v" placeholder="value" style="flex:2;min-width:160px">
        <button class="btn btn-primary" id="kv-put">Put</button>
      </div>
      ${kv.kv.length ? `<table>${kv.kv.map(r => `<tr><td class="mono"><b>${esc(r.k)}</b></td>
        <td class="mono">${esc(String(r.v).slice(0, 60))}</td>
        <td class="mono" style="color:var(--faint)">${esc(short(r.peer))}</td></tr>`).join("")}</table>`
        : `<p class="hint">Empty. Last-writer-wins, signed by each writer.</p>`}
    </div>

    <div class="card"><h2>Log</h2>
      <div class="row">
        <input id="log-type" placeholder="type" style="flex:1;min-width:100px;max-width:160px">
        <input id="log-body" placeholder="entry…" style="flex:3;min-width:160px">
        <button class="btn btn-primary" id="log-put">Append</button>
      </div>
      ${log.entries.slice().reverse().map(e => `<div style="padding:8px 0;border-bottom:1px solid var(--line)">
        <span class="log-type">${esc(e.type || "note")}</span>
        <span class="mono" style="color:var(--faint);font-size:11px"> ${esc(short(e.peer))} #${e.seq}</span>
        <pre class="body">${esc(e.body)}</pre></div>`).join("") || `<p class="hint">Nothing logged yet.</p>`}
    </div>`;

  document.getElementById("mk-invite").onclick = async () => {
    try {
      const d = await api("/api/peers/invite", { method: "POST" });
      document.getElementById("invite-out").style.display = "flex";
      document.getElementById("invite-code").value = d.code;
    } catch (e) { toast(e.message); }
  };
  document.getElementById("copy-invite").onclick = async () => {
    const el = document.getElementById("invite-code");
    try { await navigator.clipboard.writeText(el.value); toast("Copied."); }
    catch { el.select(); toast("Copy it manually."); }
  };
  document.getElementById("sync-now").onclick = async () => {
    try { const d = await api("/api/sync/now", { method: "POST" });
      toast(d.reports.filter(r => r.ok).length + "/" + d.reports.length + " peers synced."); render();
    } catch (e) { toast(e.message); }
  };
  document.getElementById("join").onclick = async () => {
    const code = document.getElementById("join-code").value.trim();
    if (!code) return;
    try { await api("/api/peers/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
      toast("Peer added."); render();
    } catch (e) { toast(e.message); }
  };
  app.querySelectorAll("[data-unpeer]").forEach(b => b.onclick = async () => {
    if (!confirm("Remove this peer?")) return;
    await api("/api/peers/" + b.dataset.unpeer, { method: "DELETE" }); render();
  });
  document.getElementById("blob-put").onclick = async () => {
    const f = document.getElementById("blob-file").files[0];
    if (!f) { toast("Pick a file first."); return; }
    try {
      const d = await api("/api/blobs", { method: "POST", body: f });
      try { await api("/api/blobs/" + d.hash + "/pin", { method: "POST" }); } catch {}
      toast("Stored " + d.hash.slice(0, 12) + "… (pinned)"); render();
    } catch (e) { toast(e.message); }
  };
  app.querySelectorAll("[data-pin]").forEach(b => b.onclick = async () => {
    await api("/api/blobs/" + b.dataset.pin + (b.dataset.pinned === "1" ? "/unpin" : "/pin"), { method: "POST" });
    render();
  });
  document.getElementById("kv-put").onclick = async () => {
    const k = document.getElementById("kv-k").value.trim(), v = document.getElementById("kv-v").value;
    if (!k) return;
    try { await api("/api/kv/" + encodeURIComponent(k), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: v }) });
      toast("Saved."); render();
    } catch (e) { toast(e.message); }
  };
  document.getElementById("log-put").onclick = async () => {
    const t = document.getElementById("log-type").value.trim() || "note", b2 = document.getElementById("log-body").value;
    if (!b2.trim()) return;
    try { await api("/api/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: t, body: b2 }) });
      toast("Logged."); render();
    } catch (e) { toast(e.message); }
  };
}
render().catch(e => { app.innerHTML = `<p class="loading">failed: ${esc(e.message)}</p>`; });

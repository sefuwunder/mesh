// server.ts — mesh: a peer-to-peer storage/networking node.
// Bun + zero dependencies + SQLite. Port 3014.
//
// Each node exposes this HTTP API through its own Cloudflare tunnel
// (`cloudflared tunnel --url http://localhost:3014`) and peers join via
// invite codes — no central server, no port forwarding. Replication is pull
// gossip; every entry is signature-checked before it touches the database.
import { MeshStore } from "./store";
import { gossipRound } from "./sync";
import { readFileSync, existsSync } from "node:fs";
import { join, normalize } from "node:path";

const PORT = Number(process.env.MESH_PORT || 3014);
const PUBLIC_DIR = join(new URL(".", import.meta.url).pathname, "..", "public");
const MAX_BLOB = 25 * 1024 * 1024;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function err(message: string, status = 400): Response { return json({ error: message }, status); }
async function bodyJson(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}
function serveStatic(pathname: string): Response | null {
  const rel = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^\/+/, "");
  if (rel.includes("..") || rel.startsWith(".")) return null;
  const full = join(PUBLIC_DIR, rel);
  if (!existsSync(full)) return null;
  const ext = rel.split(".").pop() || "";
  const type: Record<string, string> = {
    html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8",
    css: "text/css; charset=utf-8", json: "application/json", svg: "image/svg+xml",
  };
  return new Response(readFileSync(full), { headers: { "Content-Type": type[ext] || "application/octet-stream" } });
}

export function createServer(store: MeshStore, port = PORT) {
  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const q = url.searchParams;

      if (req.method === "GET" && (path === "/" || path.startsWith("/app.js") || path.startsWith("/styles.css"))) {
        return serveStatic(path) || err("not found", 404);
      }

      // ---- node ------------------------------------------------------------
      if (path === "/api/status" && req.method === "GET") {
        return json({
          id: store.identity.id, url: store.publicUrl,
          peers: store.listPeers().length,
          blobs: store.listBlobs().length,
          pinned: store.pinnedHashes(100000).length,
          kvEntries: store.listKv().length,
          logEntries: store.logCount(),
          uptimeSec: Math.floor((Date.now() - store.startedAt) / 1000),
        });
      }

      // ---- peers -----------------------------------------------------------
      if (path === "/api/peers/invite" && req.method === "POST") {
        return json({ code: store.createInvite(), url: store.publicUrl, id: store.identity.id });
      }
      if (path === "/api/peers/join" && req.method === "POST") {
        const b = await bodyJson(req);
        if (!b.code) return err("code required");
        try {
          const p = store.joinViaInvite(b.code, String(b.name || "").slice(0, 60));
          return json({ peer: p });
        } catch (e: any) { return err(e.message || "bad invite"); }
      }
      if (path === "/api/peers" && req.method === "GET") return json({ peers: store.listPeers() });
      const delPeer = path.match(/^\/api\/peers\/([0-9a-f]{32})$/);
      if (delPeer && req.method === "DELETE") {
        return json({ removed: store.removePeer(delPeer[1]) });
      }

      // ---- blobs -----------------------------------------------------------
      if (path === "/api/blobs" && req.method === "POST") {
        const buf = await req.arrayBuffer();
        if (!buf.byteLength) return err("empty body");
        if (buf.byteLength > MAX_BLOB) return err("blob too large (25 MB max)", 413);
        return json(store.putBlob(new Uint8Array(buf)), 201);
      }
      if (path === "/api/blobs" && req.method === "GET") return json({ blobs: store.listBlobs() });
      const blobGet = path.match(/^\/api\/blobs\/([0-9a-f]{64})$/);
      if (blobGet && req.method === "GET") {
        const bytes = store.getBlob(blobGet[1]);
        if (!bytes) return err("not found", 404);
        return new Response(bytes as BodyInit, { headers: { "Content-Type": "application/octet-stream" } });
      }
      const blobPin = path.match(/^\/api\/blobs\/([0-9a-f]{64})\/(pin|unpin)$/);
      if (blobPin && req.method === "POST") {
        const ok = store.pinBlob(blobPin[1], blobPin[2] === "pin");
        if (!ok) return err("not found", 404);
        return json({ hash: blobPin[1], pinned: blobPin[2] === "pin" });
      }

      // ---- log -------------------------------------------------------------
      if (path === "/api/log" && req.method === "POST") {
        const b = await bodyJson(req);
        return json(store.appendLog(String(b.type || ""), String(b.body ?? "")), 201);
      }
      if (path === "/api/log" && req.method === "GET") {
        return json({
          entries: store.getLog(
            q.get("peer") || undefined,
            Number(q.get("since") || 0),
            Number(q.get("limit") || 200),
          ),
        });
      }

      // ---- kv --------------------------------------------------------------
      if (path === "/api/kv" && req.method === "GET") return json({ kv: store.listKv() });
      const kvKey = path.match(/^\/api\/kv\/(.+)$/);
      if (kvKey) {
        const key = decodeURIComponent(kvKey[1]);
        if (!key || key.length > 256) return err("bad key");
        if (req.method === "GET") {
          const row = store.getKv(key);
          return row ? json(row) : err("not found", 404);
        }
        if (req.method === "PUT") {
          const b = await bodyJson(req);
          return json(store.putKv(key, String(b.value ?? "")));
        }
      }

      // ---- sync (peer-to-peer; all payloads signature-checked) --------------
      if (path === "/api/sync/state" && req.method === "GET") {
        return json({
          id: store.identity.id, pubkey: store.identity.publicKey,
          logHeads: store.getLogHeads(), pinned: store.pinnedHashes(),
          peerCount: store.listPeers().length,
        });
      }
      const syncLog = path.match(/^\/api\/sync\/log\/([0-9a-f]{32})$/);
      if (syncLog && req.method === "GET") {
        return json(store.getLog(syncLog[1], Number(q.get("since") || 0), Number(q.get("limit") || 200)));
      }
      if (path === "/api/sync/kv" && req.method === "GET") return json(store.listKv());
      if (path === "/api/sync/peers" && req.method === "GET") {
        return json(store.listPeers().slice(0, 100).map(p => ({ id: p.id, url: p.url, pubkey: p.pubkey, name: p.name })));
      }
      if (path === "/api/sync/now" && req.method === "POST") {
        return json({ reports: await gossipRound(store) });
      }

      return err("not found", 404);
    },
  });
}

const isMain = (import.meta as any).main !== false && process.argv[1]?.endsWith("server.ts");
if (isMain) {
  const store = MeshStore.open();
  const server = createServer(store);
  console.log(`mesh node ${store.identity.id} on :${server.port}  public: ${store.publicUrl}`);
  console.log(`data: ${store.dataDir}`);
  const tick = () => gossipRound(store).then(rs => {
    const ok = rs.filter(r => r.ok).length;
    if (rs.length) console.log(`[gossip] ${ok}/${rs.length} peers ok`);
  }).catch(e => console.error("[gossip]", e));
  setTimeout(tick, 8000);
  setInterval(tick, 30000);
}

// sync.test.ts — two real nodes over HTTP (the same protocol a Cloudflare
// tunnel carries); gossip replicates log, KV, pinned blobs, and peers.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MeshStore } from "../src/store";
import { createServer } from "../src/server";
import { syncWithPeer } from "../src/sync";

let a: MeshStore, b: MeshStore, c: MeshStore;
let servers: { stop(): void }[] = [];

function node(): MeshStore {
  const s = new MeshStore(mkdtempSync(join(tmpdir(), "mesh-sync-")), "http://placeholder");
  const srv = createServer(s, 0);
  s.publicUrl = `http://127.0.0.1:${srv.port}`;
  servers.push(srv);
  return s;
}

beforeAll(() => { a = node(); b = node(); c = node(); });
afterAll(() => { for (const s of servers) s.stop(); });

describe("mesh sync over HTTP", () => {
  test("invite join links two nodes", async () => {
    const p = b.joinViaInvite(a.createInvite(), "node-a");
    expect(p.id).toBe(a.identity.id);
    expect(b.getPeer(a.identity.id)?.url).toBe(a.publicUrl);
  });

  test("gossip replicates log, kv and pinned blobs", async () => {
    const entry = a.appendLog("note", "hello from a");
    a.putKv("greeting", "hi");
    const { hash } = a.putBlob(new TextEncoder().encode("replicate me"));
    a.pinBlob(hash, true);

    const rep = await syncWithPeer(b, b.getPeer(a.identity.id)!);
    expect(rep.ok).toBe(true);
    expect(rep.logEntries).toBe(1);
    expect(rep.kvApplied).toBe(1);
    expect(rep.blobsFetched).toBe(1);

    const entries = b.getLog(a.identity.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe("hello from a");
    expect(entries[0].sig).toBe(entry.sig);
    expect(b.getKv("greeting")?.v).toBe("hi");
    const blob = b.getBlob(hash);
    expect(blob && new TextDecoder().decode(blob)).toBe("replicate me");
  });

  test("second sync is a no-op", async () => {
    const rep = await syncWithPeer(b, b.getPeer(a.identity.id)!);
    expect(rep.ok).toBe(true);
    expect(rep.logEntries).toBe(0);
    expect(rep.kvApplied).toBe(0);
    expect(rep.blobsFetched).toBe(0);
  });

  test("forged log entry is rejected during sync", async () => {
    // a appends a real entry, then we try to slip a forged one into b directly
    const real = a.appendLog("note", "real");
    const forged = { ...real, seq: real.seq + 100, body: "forged" };
    expect(b.insertLogEntry(forged)).toBe(false);
    const rep = await syncWithPeer(b, b.getPeer(a.identity.id)!);
    expect(rep.ok).toBe(true);
    expect(b.getLog(a.identity.id).find(e => e.body === "forged")).toBeUndefined();
    expect(b.getLog(a.identity.id)).toHaveLength(2);
  });

  test("transitive peer discovery", async () => {
    // c joins a directly (no server needed for c to be known)
    a.joinViaInvite(c.createInvite(), "node-c");
    const rep = await syncWithPeer(b, b.getPeer(a.identity.id)!);
    expect(rep.peersLearned).toBe(1);
    const learned = b.getPeer(c.identity.id);
    expect(learned?.url).toBe(c.publicUrl);
    expect(learned?.via).toBe(a.identity.id);
  });

  test("identity mismatch is refused", async () => {
    // point a peer record at the wrong URL: the node there has a different id
    const evil = b.addPeer(a.identity.id, c.publicUrl, a.identity.publicKey, "evil");
    const rep = await syncWithPeer(b, evil);
    expect(rep.ok).toBe(false);
    expect(rep.error).toMatch(/identity mismatch/);
    b.addPeer(a.identity.id, a.publicUrl, a.identity.publicKey, "node-a"); // restore
  });

  test("unreachable peer reports error, marks last_seen", async () => {
    const tmp = new MeshStore(mkdtempSync(join(tmpdir(), "mesh-sync-")), "http://127.0.0.1:1");
    const g = b.addPeer(tmp.identity.id, "http://127.0.0.1:1", tmp.identity.publicKey, "ghost");
    const rep = await syncWithPeer(b, g);
    expect(rep.ok).toBe(false);
    expect(rep.error).toBeTruthy();
    expect(b.getPeer(g.id)?.last_seen).toBeGreaterThan(0);
    b.removePeer(g.id);
  });

  test("sync endpoints serve the protocol", async () => {
    const st = await (await fetch(`${a.publicUrl}/api/sync/state`)).json();
    expect(st.id).toBe(a.identity.id);
    expect(st.pubkey).toBe(a.identity.publicKey);
    expect(st.logHeads[a.identity.id]).toBeGreaterThan(0);
    const kv = await (await fetch(`${a.publicUrl}/api/sync/kv`)).json();
    expect(kv.find((r: any) => r.k === "greeting")?.v).toBe("hi");
    const peers = await (await fetch(`${a.publicUrl}/api/sync/peers`)).json();
    expect(peers.find((p: any) => p.id === c.identity.id)).toBeTruthy();
  });
});

// store.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MeshStore, logCanonical, sha256hex } from "../src/store";
import { signData } from "../src/identity";

let store: MeshStore;
beforeEach(() => {
  store = new MeshStore(mkdtempSync(join(tmpdir(), "mesh-store-")), "http://localhost:1");
});

describe("blobs", () => {
  test("put/get round-trip with content addressing", () => {
    const bytes = new TextEncoder().encode("the quick brown fox");
    const { hash, size } = store.putBlob(bytes);
    expect(hash).toBe(sha256hex(bytes));
    expect(size).toBe(bytes.length);
    const back = store.getBlob(hash);
    expect(back).not.toBeNull();
    expect(new TextDecoder().decode(back!)).toBe("the quick brown fox");
  });

  test("duplicate put is idempotent", () => {
    const bytes = new TextEncoder().encode("same");
    const a = store.putBlob(bytes);
    const b = store.putBlob(bytes);
    expect(a.hash).toBe(b.hash);
    expect(store.listBlobs()).toHaveLength(1);
  });

  test("missing blob returns null", () => {
    expect(store.getBlob("0".repeat(64))).toBeNull();
    expect(store.getBlob("not-a-hash")).toBeNull();
  });

  test("pin / unpin", () => {
    const { hash } = store.putBlob(new TextEncoder().encode("pin me"));
    expect(store.pinBlob(hash, true)).toBe(true);
    expect(store.listBlobs()[0].pinned).toBe(true);
    expect(store.pinnedHashes()).toContain(hash);
    expect(store.pinBlob(hash, false)).toBe(true);
    expect(store.pinnedHashes()).not.toContain(hash);
  });
});

describe("log", () => {
  test("append assigns increasing seq and signs", () => {
    const e1 = store.appendLog("note", "first");
    const e2 = store.appendLog("note", "second");
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e1.peer).toBe(store.identity.id);
    expect(e1.sig.length).toBeGreaterThan(10);
  });

  test("getLog filters", () => {
    store.appendLog("a", "1"); store.appendLog("b", "2"); store.appendLog("a", "3");
    expect(store.getLog(undefined, 1)).toHaveLength(2);
    expect(store.getLogHeads()[store.identity.id]).toBe(3);
  });

  test("insertLogEntry verifies signature", () => {
    const e = store.appendLog("note", "mine");
    // own entry re-inserted: already exists -> false, but verifies fine
    expect(store.insertLogEntry(e)).toBe(false);
    const forged = { ...e, seq: 99, body: "forged" };
    expect(store.insertLogEntry(forged)).toBe(false);
  });

  test("insertLogEntry rejects unknown peers", () => {
    const other = new MeshStore(mkdtempSync(join(tmpdir(), "mesh-store-")), "http://localhost:2");
    const e = other.appendLog("note", "from stranger");
    expect(store.insertLogEntry(e)).toBe(false); // not a known peer
    store.addPeer(other.identity.id, "http://localhost:2", other.identity.publicKey, "stranger");
    expect(store.insertLogEntry(e)).toBe(true);  // now known -> accepted
    expect(store.insertLogEntry(e)).toBe(false); // duplicate -> false
  });
});

describe("kv", () => {
  test("put/get round-trip", () => {
    store.putKv("color", "blue");
    const row = store.getKv("color");
    expect(row?.v).toBe("blue");
    expect(row?.peer).toBe(store.identity.id);
  });

  test("last-writer-wins by timestamp", () => {
    const other = new MeshStore(mkdtempSync(join(tmpdir(), "mesh-store-")), "http://localhost:2");
    store.addPeer(other.identity.id, "http://localhost:2", other.identity.publicKey);
    const k = "seat";
    store.putKv(k, "old");
    const cur = store.getKv(k)!;
    // remote write with a newer timestamp wins
    const ts = cur.ts + 1000;
    const sig = signData(other.identity, ["mesh-kv", k, "new", String(ts), other.identity.id].join("\n"));
    expect(store.mergeKv(k, "new", ts, other.identity.id, sig)).toBe("applied");
    expect(store.getKv(k)?.v).toBe("new");
    // older timestamp is stale
    const sig2 = signData(other.identity, ["mesh-kv", k, "older", String(cur.ts), other.identity.id].join("\n"));
    expect(store.mergeKv(k, "older", cur.ts, other.identity.id, sig2)).toBe("stale");
    expect(store.getKv(k)?.v).toBe("new");
  });

  test("bad signature rejected", () => {
    expect(store.mergeKv("x", "y", Date.now(), store.identity.id, "bogus")).toBe("bad-sig");
  });

  test("unknown peer rejected", () => {
    const other = new MeshStore(mkdtempSync(join(tmpdir(), "mesh-store-")), "http://localhost:2");
    const ts = Date.now();
    const sig = signData(other.identity, ["mesh-kv", "x", "y", String(ts), other.identity.id].join("\n"));
    expect(store.mergeKv("x", "y", ts, other.identity.id, sig)).toBe("unknown-peer");
  });
});

describe("invites", () => {
  test("round-trip", () => {
    const code = store.createInvite();
    const p = MeshStore.parseInvite(code);
    expect(p?.id).toBe(store.identity.id);
    expect(p?.url).toBe(store.publicUrl);
    expect(p?.pubkey).toBe(store.identity.publicKey);
  });

  test("tampered code rejected", () => {
    const code = store.createInvite();
    const raw = JSON.parse(Buffer.from(code, "base64url").toString("utf8"));
    raw.url = "https://evil.example";
    const bad = Buffer.from(JSON.stringify(raw)).toString("base64url");
    expect(MeshStore.parseInvite(bad)).toBeNull();
    expect(MeshStore.parseInvite("garbage")).toBeNull();
  });

  test("joinViaInvite adds the peer", () => {
    const other = new MeshStore(mkdtempSync(join(tmpdir(), "mesh-store-")), "https://node.example");
    const p = store.joinViaInvite(other.createInvite(), "friend");
    expect(p.id).toBe(other.identity.id);
    expect(p.url).toBe("https://node.example");
    expect(store.getPeer(p.id)?.name).toBe("friend");
  });

  test("cannot join with your own invite", () => {
    expect(() => store.joinViaInvite(store.createInvite())).toThrow();
  });

  test("addPeer rejects id/pubkey mismatch", () => {
    expect(() => store.addPeer("0".repeat(32), "https://x.example", store.identity.publicKey)).toThrow();
  });

  test("log canonical form is stable", () => {
    const e = { peer: "p", seq: 1, type: "t", body: "b", ts: 5 };
    expect(logCanonical(e)).toBe(["mesh-log", "p", "1", "t", "5", "b"].join("\n"));
  });
});

// node.test.ts
import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MeshStore } from "../src/store";
import { resetNode } from "../src/node";

describe("resetNode", () => {
  test("wipes state and mints a fresh identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-node-"));
    const store = new MeshStore(dir, "http://localhost:1");
    const peer = new MeshStore(mkdtempSync(join(tmpdir(), "mesh-node-peer-")), "http://localhost:2");
    const oldId = store.identity.id;
    store.putKv("k1", "v1");
    store.addPeer(peer.identity.id, peer.publicUrl, peer.identity.publicKey, "peer");
    store.appendLog("note", "hello");
    const { hash } = store.putBlob(new TextEncoder().encode("blobdata"));
    store.pinBlob(hash);

    resetNode(store);

    expect(store.identity.id).not.toBe(oldId);
    expect(store.identity.id).toHaveLength(32);
    expect(store.listKv()).toHaveLength(0);
    expect(store.listPeers()).toHaveLength(0);
    expect(store.logCount()).toBe(0);
    expect(store.getBlob(hash)).toBeNull();
    // new identity persisted
    const again = new MeshStore(dir, "http://localhost:1");
    expect(again.identity.id).toBe(store.identity.id);
  });
});

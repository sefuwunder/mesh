// adverts.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MeshStore } from "../src/store";
import { publishAdvert, retractAdvert, listAdverts, findAdvert } from "../src/adverts";

const NS = "test:advert";

let a: MeshStore;
let b: MeshStore;
beforeEach(() => {
  a = new MeshStore(mkdtempSync(join(tmpdir(), "mesh-adv-a-")), "http://localhost:1");
  b = new MeshStore(mkdtempSync(join(tmpdir(), "mesh-adv-b-")), "http://localhost:2");
  // b trusts a so it can merge a's signed rows (simulating gossip)
  b.addPeer(a.identity.id, a.publicUrl, a.identity.publicKey, "a");
});

function gossipRow(from: MeshStore, to: MeshStore, k: string) {
  const row = from.getKv(k)!;
  expect(to.mergeKv(row.k, row.v, row.ts, row.peer, row.sig)).toBe("applied");
}

describe("adverts", () => {
  test("publish -> list -> find round-trip", () => {
    publishAdvert(a, NS, "circle-1", { code: "abc123", circleName: "Exec circle" });
    const all = listAdverts(a, NS);
    expect(all).toHaveLength(1);
    expect(all[0].advertId).toBe("circle-1");
    expect(all[0].nodeId).toBe(a.identity.id);
    expect(all[0].payload.code).toBe("abc123");
    const found = findAdvert(a, NS, (x) => x.payload.code === "abc123");
    expect(found?.advertId).toBe("circle-1");
    expect(findAdvert(a, NS, (x) => x.payload.code === "nope")).toBeNull();
  });

  test("republish is idempotent, key stays stable", async () => {
    const r1 = publishAdvert(a, NS, "c1", { code: "one" });
    // LWW uses ms timestamps: two writes in the same ms tie-break stale,
    // so space the republishes (real republishes happen seconds apart).
    await new Promise((r) => setTimeout(r, 2));
    const r2 = publishAdvert(a, NS, "c1", { code: "two" });
    expect(r1.k).toBe(r2.k);
    expect(listAdverts(a, NS)).toHaveLength(1);
    expect(listAdverts(a, NS)[0].payload.code).toBe("two");
  });

  test("retract hides the advert", () => {
    publishAdvert(a, NS, "c1", { code: "one" });
    expect(listAdverts(a, NS)).toHaveLength(1);
    retractAdvert(a, NS, "c1");
    expect(listAdverts(a, NS)).toHaveLength(0);
  });

  test("namespaces are isolated; malformed rows skipped", () => {
    publishAdvert(a, NS, "c1", { code: "one" });
    publishAdvert(a, "other:ns", "c1", { code: "other" });
    a.putKv(NS + ":broken", "not-json{{{");
    expect(listAdverts(a, NS)).toHaveLength(1);
    expect(listAdverts(a, "other:ns")).toHaveLength(1);
  });

  test("adverts replicate to a peer via gossip", () => {
    const row = publishAdvert(a, NS, "circle-9", { code: "zz99", expiresAt: null });
    gossipRow(a, b, row.k);
    const found = findAdvert(b, NS, (x) =>
      x.payload.code.toLowerCase() === "zz99" &&
      (!x.payload.expiresAt || Date.parse(x.payload.expiresAt) > Date.now()));
    expect(found?.advertId).toBe("circle-9");
    expect(found?.nodeId).toBe(a.identity.id);
    // retraction replicates too
    const rrow = retractAdvert(a, NS, "circle-9");
    gossipRow(a, b, rrow.k);
    expect(listAdverts(b, NS)).toHaveLength(0);
  });

  test("expired adverts are findable-by-predicate but expirable by caller", () => {
    publishAdvert(a, NS, "c1", { code: "old", expiresAt: new Date(Date.now() - 1000).toISOString() });
    const all = listAdverts(a, NS);
    expect(all).toHaveLength(1); // still listed — expiry is the app's call
    const valid = findAdvert(a, NS, (x) =>
      x.payload.code === "old" && Date.parse(x.payload.expiresAt) > Date.now());
    expect(valid).toBeNull();
  });
});

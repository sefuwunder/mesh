// adverts.ts — advertisements over the signed KV.
//
// An advertisement is a small signed JSON payload published under
//   <namespace>:<nodeId>:<advertId>
// Peers discover adverts by scanning the KV (listKv is local; gossip carries
// them mesh-wide). Republishing is idempotent — the key is stable, so a
// rotated payload (new code, new expiry) overwrites in place. Retraction is
// a tombstone payload ({ deleted: true }); listAdverts skips tombstones.
//
// Provenance: Abba used exactly this for circle invites
// (namespace "abba:circle-invite", advertId = the circle's stable mesh id):
// every node republished its invites each gossip tick so expiry propagated
// without restarts, and peers discovered codes via findAdvert. Any app can
// pick its own namespace — presence beacons, share offers, service announcements.
import type { MeshStore, KvRow } from "./store";

export interface Advert {
  nodeId: string;
  advertId: string;
  payload: any;
  ts: number;   // KV last-writer timestamp (ms)
  peer: string; // node the row was last written by
}

function keyFor(namespace: string, nodeId: string, advertId: string): string {
  return `${namespace}:${nodeId}:${advertId}`;
}

/** Publish (or republish) an advertisement. Idempotent; the key never changes. */
export function publishAdvert(store: MeshStore, namespace: string, advertId: string, payload: Record<string, any>): KvRow {
  return store.putKv(
    keyFor(namespace, store.identity.id, advertId),
    JSON.stringify({ ...payload, originNode: store.identity.id, updatedAt: Date.now() }),
  );
}

/** Retract an advertisement so peers stop honoring it. */
export function retractAdvert(store: MeshStore, namespace: string, advertId: string): KvRow {
  return store.putKv(
    keyFor(namespace, store.identity.id, advertId),
    JSON.stringify({ deleted: true, originNode: store.identity.id, updatedAt: Date.now() }),
  );
}

function parseAdvert(store: MeshStore, namespace: string, row: KvRow): Advert | null {
  const rest = row.k.slice(namespace.length + 1).split(":");
  if (rest.length < 2) return null;
  const nodeId = rest[0];
  const advertId = rest.slice(1).join(":");
  let payload: any;
  try { payload = JSON.parse(row.v); } catch { return null; }
  if (payload && payload.deleted) return null;
  return { nodeId, advertId, payload, ts: row.ts, peer: row.peer };
}

/** Every live advertisement under a namespace, all nodes. */
export function listAdverts(store: MeshStore, namespace: string): Advert[] {
  const prefix = namespace + ":";
  const out: Advert[] = [];
  for (const row of store.listKv()) {
    if (!row.k.startsWith(prefix)) continue;
    const a = parseAdvert(store, namespace, row);
    if (a) out.push(a);
  }
  return out;
}

/** First live advert matching a predicate (e.g. code + expiry check), or null. */
export function findAdvert(store: MeshStore, namespace: string, match: (a: Advert) => boolean): Advert | null {
  for (const a of listAdverts(store, namespace)) {
    if (match(a)) return a;
  }
  return null;
}

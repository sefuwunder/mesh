// node.ts — node lifecycle operations.
import { readdirSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createIdentity } from "./identity";
import type { MeshStore } from "./store";

/**
 * Factory reset the node: new identity, empty KV/peers/blobs/log.
 * The node becomes a brand-new peer — old peers will not recognize it.
 * Provenance: Abba's mesh bridge used this for its "reset Abba" flow.
 */
export function resetNode(store: MeshStore): void {
  store.db.exec("DELETE FROM peers; DELETE FROM kv; DELETE FROM blobs; DELETE FROM log_entries;");
  try {
    for (const f of readdirSync(join(store.dataDir, "blobs"))) {
      rmSync(join(store.dataDir, "blobs", f), { recursive: true });
    }
    mkdirSync(join(store.dataDir, "blobs"), { recursive: true });
  } catch { /* nothing stored yet */ }
  store.identity = createIdentity(store.dataDir);
}

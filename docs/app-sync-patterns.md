# App sync patterns

How to build an application on the mesh KV, distilled from Abba's mesh
bridge (`meshbridge.ts`), which synced notes, reactions, comments, invites,
and credentials between peered instances. Everything below is a convention
over the signed KV — the mesh itself doesn't know about records, only keys.

## Key schemas

Pick the schema that matches your write pattern. All values are JSON.

### 1. Single-writer record (last-writer-wins)

```
<app>:note:<globalId>   -> full snapshot
```

- One writer: the node that owns the record. Nobody else writes this key.
- Readers take the newest `updatedAt` they see; the writer's own row is skipped (it's already local).
- The global id embeds the origin node (`<nodeId>:<localId>`) so ids never collide across nodes.

### 2. Per-writer keys (no clobbering)

```
<app>:react:<globalId>:<writerNode>:<kind>   -> { on, by, ts }
```

- When many nodes write about the same entity, give each writer its own key.
- Writers can never overwrite each other; readers fold all keys for the entity.
- Toggling off is a value (`{ on: false }`), not a delete — deletes don't replicate, values do.

### 3. Immutable records

```
<app>:comment:<globalId>:<commentGlobalId>   -> { body, by, createdAt }
```

- Write-once payloads addressed by their own global id.
- Readers dedupe by id (`INSERT OR IGNORE` / seen-set).

### 4. Retractions and tombstones

Unsharing or deleting is a **value**, never a key deletion:

```json
{ "gid": "...", "retracted": true, "updatedAt": "..." }
{ "gid": "...", "deleted": true, "updatedAt": "..." }
```

Readers apply the tombstone (drop the local copy) and only then mark the key
seen. A reader that hasn't paired/routed the record yet returns "not applied"
so the key is retried next round — never mark-then-drop.

## The apply loop

Gossip only moves bytes; the app folds them in. Abba's loop, generalized:

```
gossipRound(store)            # pull bytes from peers (mesh does this)
backfill()                    # heal pre-existing state (pairings, ids)
completePending()             # finish two-phase setups once data arrives
applyNewKeys()                # fold unseen KV rows into the app DB
republish()                   # re-advertise own state (invites, presence)
```

`applyNewKeys` needs **seen-tracking**: a table of `(key, ts)` marking what
the app already folded. Skip own keys (`originNode === myId`). Skip rows from
blocked nodes (mark seen, don't apply). On apply failure, leave the key
unseen so the next tick retries it. The whole loop is idempotent — run it on
a timer (Abba: every 30s) and after any local publish.

## Advertisements

For discovery (invites, beacons, share offers), see `src/adverts.ts`:
`publishAdvert` / `retractAdvert` / `listAdverts` / `findAdvert`. One stable
key per advert (`<namespace>:<nodeId>:<advertId>`), republished on a timer so
rotation and expiry propagate without restarts.

## Pairing

When records belong to a *scope* (Abba: which local circle a remote note
lands in), keep a pairing table locally:

```
pairings(local_scope, peer_node_id, remote_scope_id)
```

Incoming records carry their remote scope id; `routeToScope()` maps it to a
local scope or returns "unpaired — retry later". Pairing itself can be
advertised (Abba published circle invites; pairing completed when the peer's
advertised scopes became visible).

## The peer protocol

Peers talk HTTP (`/api/sync/*`, see `src/server.ts`): state (id, pubkey, log
heads, pinned hashes), log segments, KV dump, peer list. Every replicated row
is signature-verified against the *known* peer's pubkey at merge time —
unknown peers' data is never stored. The app layer never re-verifies; it
trusts the store.

## What stays local

Only records the user explicitly shares leave the node. Private state never
gets a key. This is an app rule, not a mesh rule — enforce it at publish
time (`publishNote` refused unshared notes), because the mesh replicates
every key it's given.

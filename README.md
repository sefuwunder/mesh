# mesh

A peer-to-peer storage and networking backend that runs over Cloudflare tunnels.
Bun + zero dependencies + SQLite. Port 3014.

Each node is a small server with a stable ed25519 identity. It exposes an HTTP
API through its own `cloudflared` tunnel — no port forwarding, no central
server. Peers join by exchanging invite codes, then replicate over pull gossip.
Every entry that crosses the wire is signature-checked before it touches the
database.

## What it stores

- **Blobs** — content-addressed (`sha256` is the address). `POST` raw bytes,
  `GET` by hash. Pin the ones you care about; pinned blobs replicate to every
  peer that syncs with you.
- **Log** — a signed append-only log per peer. Good for feeds, events, audit
  trails.
- **KV** — signed last-writer-wins key–value. Good for config, presence,
  lightweight shared state.

## Quickstart

```bash
cd mesh
bun src/server.ts
```

Open http://localhost:3014 for the dashboard.

### Going peer-to-peer over a Cloudflare tunnel

On each machine:

```bash
# 1. expose the node (free, no account needed for a quick tunnel)
cloudflared tunnel --url http://localhost:3014
# -> https://some-name.trycloudflare.com

# 2. tell the node its public address and restart
PUBLIC_URL=https://some-name.trycloudflare.com MESH_PORT=3014 bun src/server.ts
```

For a stable address, create a named tunnel once and route a hostname to it:

```bash
cloudflared tunnel create mesh-node
cloudflared tunnel route dns mesh-node mesh.example.com
cloudflared tunnel run --url http://localhost:3014 mesh-node
```

Then peer the nodes: on node A, hit **Create invite code**, paste the code into
node B's **Join** box. That's it — B verifies the code's signature, pins A's
identity (peer id must match the pubkey), and gossip starts within ~30s
(**Sync now** forces a round immediately). Peers also exchange peer lists, so
C joining A becomes discoverable to B automatically.

### Environment

| var          | default                  | what                          |
| ------------ | ------------------------ | ----------------------------- |
| `MESH_PORT`  | `3014`                   | listen port                   |
| `MESH_DATA`  | `./data`                 | sqlite db, identity, blobs    |
| `PUBLIC_URL` | `http://localhost:PORT`  | address baked into invites    |

`data/identity.json` (0600) holds the node's keypair — back it up; losing it
means a new peer id.

## API

```
GET    /api/status            node id, url, counts
POST   /api/peers/invite      -> { code, url, id }
POST   /api/peers/join        { code, name? }
GET    /api/peers             DELETE /api/peers/:id
POST   /api/blobs             raw bytes -> { hash, size } (25 MB max)
GET    /api/blobs/:hash       GET /api/blobs (list)
POST   /api/blobs/:hash/pin|unpin
POST   /api/log               { type, body } -> signed entry
GET    /api/log?peer=&since=&limit=
PUT    /api/kv/:key           { value }   GET /api/kv/:key   GET /api/kv
GET    /api/sync/state        id, pubkey, log heads, pinned hashes
GET    /api/sync/log/:peer?since=&limit=
GET    /api/sync/kv           GET /api/sync/peers
POST   /api/sync/now          run a gossip round now
```

## Trust model

- The **invite code is the trust root** (bearer credential). It binds a tunnel
  URL to a pubkey with the inviter's signature; the joiner also checks
  `peer id == sha256(pubkey)`.
- **Everything replicated is signed**: log entries and KV rows carry ed25519
  signatures and are verified against the *known* peer's pubkey before insert.
  Unknown peers' data is ignored.
- **Blobs are content-addressed**: the hash is the integrity check; a corrupt
  or malicious blob simply hashes differently.
- **Sync refuses identity mismatch**: if the node behind a peer's URL ever
  presents a different id/pubkey, the round aborts.
- Transport security comes from the tunnel (HTTPS). There is no additional
  access control on the API — run it behind the tunnel, not on the open
  internet, and treat the dashboard as operator-only.

## Tests

```bash
bun test   # 31 tests: identity, store, live two-node gossip over HTTP
```

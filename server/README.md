# FiberLens reference sync server

Zero-dependency Node.js server implementing the FiberLens sync contract.

```bash
FIBERLENS_TOKEN=change-me PORT=8787 node server/index.mjs
```

Then in the app: **More → Cloud sync** → URL `https://your-host` (put the server behind HTTPS),
token `change-me`, optional end-to-end passphrase (identical on every device).

## Contract

| Endpoint | Body | Response |
|----------|------|----------|
| `POST /sync/push` | `{ changes: RemoteChange[] }` | `{ ok, seq }` |
| `POST /sync/pull` | `{ since?: string, projectIds: string[] }` | `{ changes: RemoteChange[], cursor: string }` |
| `GET /health` | — | `{ ok, seq, changes }` |

`RemoteChange = { table, rowId, op: 'put'|'delete', hlc, projectId?, row? | enc? }`

* `hlc` — hybrid logical clock of the client (ordering across devices).
* `enc` — AES-256-GCM encrypted row (base64) when the client uses a passphrase; the server
  stores it opaquely and cannot read project data.
* Pull returns the latest change per row after the cursor. Clients resolve conflicts with
  last-writer-wins on `updatedAt` and keep the losing version for review.

Data is stored as an append-only JSON-lines log in `fiberlens-sync-data/` (back it up).
For many users or very large media, replace the log with PostgreSQL + object storage —
the HTTP contract stays the same.

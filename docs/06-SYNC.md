# Cloud Sync Architecture

FiberLens never depends on the network during field work. Sync is an optional layer on top
of the local IndexedDB database.

```
local write ──► IndexedDB row (updatedAt, updatedBy) ──► syncOutbox (table,rowId,op,HLC)
                                                             │  online & enabled (every 2 min / on reconnect)
                                                             ▼
                              dedupe per row → (encrypt) → POST /sync/push
                              POST /sync/pull?since=cursor → apply → conflicts (LWW, losing copy kept)
```

* **Hybrid logical clock** `wallclock-counter-node` orders changes across devices with skewed clocks.
* **Granularity:** FTTH rows, cores (per cable), splitters, splices, notes, photos, surveys, faults,
  maintenance, tracks, calibrations, versions and drawing working copies.
* **Conflicts:** last writer wins per row on `updatedAt`; the newer local row is kept and re-pushed,
  the remote one is stored in the conflict list for review. CAD edits are journaled transactions, so
  a future CRDT/OT merge for concurrent drawing edits can replay journals instead of snapshots.
* **Security:** HTTPS + bearer token; optional end-to-end passphrase → AES-256-GCM per row, so the
  server stores opaque blobs.
* **Server:** `server/index.mjs` (zero-dependency reference). Production: PostgreSQL + S3-compatible
  media storage behind the same HTTP contract, with per-project ACLs mapped from FiberLens roles.

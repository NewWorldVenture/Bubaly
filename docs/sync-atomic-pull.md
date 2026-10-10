# Atomic standard sync pull persistence

Migration 0479 adds two service-only RPCs. `ensure_sync_pull_container` admits the persisted account and returns one calendar or reminder-list identity. `create_sync_pull_item` inserts a remote event or reminder together with its external mapping and the existing change-log trigger in one transaction. A mapping failure rolls back the item and its audit row.

The container RPC accepts enabled standard import, export, and two-way accounts so export-only sync can still resolve its provider container. Item creation requires import or two-way. Both reject disabled, manual, onboarding, inactive-owner, mismatched-family, mismatched-user, and mismatched-provider admission. The migration changes no table grants or RLS policies and gives the service role no auth-table privileges. Its private auth helper locks only the persisted account owner's auth row.

Account serialization precedes nonblocking family, auth-user, account, membership, and container admission. When deletion already holds a required target, late import admission receives SQLSTATE `55P03` and must retry its transaction. When import admits first, deletion waits and then completes. An existing mapping is validated against its actual family, container, and local item. A retry returns `created: false` and the exact mapping identity without overwriting existing content or its stored hash. The engine still owns update and conflict decisions. This also handles a committed request whose response was lost.

The standalone contract loads the production 0018 sync tables, 0291 delete-safe change logger, 0346 account-owner policies, and 0355 sync write policies. It reuses the messaging fixture's real dirty-marker, membership RLS, deferred manager, assistant-retirement, account-linking, and 0476 ordering migrations. It preserves broad public default privilege parity while revoking service access to `auth.users`; it is a focused synthetic replay, not an entire migration-chain replay.

Run against an independently started disposable PostgreSQL 17 cluster:

```text
node scripts/verify-sync-atomic-pull.mjs --postgres-bin <absolute-bin-directory> --port <loopback-port> --expected-data-dir <absolute-PGDATA>
```

The runner checks PostgreSQL identity and exact data directory before creating a UUID-named database. The server port defaults to the client port. For the CI Docker service, use `--port 55443 --expected-server-port 5432 --expected-data-dir /var/lib/postgresql/data/pgdata`. The workflow checks that service's image, loopback binding, fixed PGDATA, version, and running state first.

Checks include the historical separate-item/map orphan and duplicate-on-retry behavior, atomic rollback, exact uncertain receipts, changed-content retries, exported internal items, scope poisoning, ACLs and spoofed role claims after direct grant drift, and paired sessions with actual blocker PIDs. Family deletion removes items; account and auth-user deletion preserve the original detached items and containers while removing account mappings. A deadlock never counts as an expected refusal. The runner removes its owned database even after failure, verifies removal, and neither starts nor stops the supplied cluster.

Two-way sync keeps its guard for local-only items; a supported existing internal export can still push in the same run. Import-only sync retains remote authority. The onboarding `calendar_events` flow is excluded. General ICS handling, TZID, EXDATE, RECURRENCE-ID, feed parsing, and CalDAV conditional export remain open. This change makes a new item/mapping pair atomic; it does not make an entire batch, existing-item update, mapping update, or outbound provider transaction atomic. Verification is local and synthetic: it does not establish hosted schema acceptance or verify a production catalog, production DDL, or provider behavior.

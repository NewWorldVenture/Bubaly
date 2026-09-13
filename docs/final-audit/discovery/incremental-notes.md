# Incremental discovery snapshot

`incremental-inventory.json` compares c7b56eff with the inspected working tree (HEAD c2367f20586eeecf8849265c5482c564c5684499) and incoming `origin/main` pinned to 5c60d05dd58e5cf6615047bc7d1708fbdad6244a. It contains **76 distinct paths**: 61 changed working-tree paths and 23 incoming paths, with overlap. Generated audit documents are excluded. Product/config/tooling source accounts for 44 paths; tests/helpers 29; support documentation 3.

- **21 new working-tree files:** 2 production libraries (`lib/display/calendar.ts`, `lib/server/native-push.ts`) and 19 tests/helpers.
- **7 incoming-only files:** the provider status API route, two OAuth configuration scripts, three tests and one runbook.
- **22 newly exported production/tooling functions**, plus the new **GET `/api/sync/[provider]/status`** handler. Function candidates use `relative/path#exportName`; HTTP candidates preserve the master's `/route:METHOD` key convention.
- **8 new production environment names:** `APNS_ENVIRONMENT`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY`, `APNS_TEAM_ID`, `APNS_TOPIC`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY`, `FCM_PROJECT_ID`. Local changes retire `FCM_SERVER_KEY`; incoming configuration tooling adds references to 13 names already present in baseline source/templates. Incoming package metadata adds `verify:oauth`.

The JSON includes exact SHA256 snapshots, export/function lines, route methods, environment names, baseline deltas, and existing audit `id`/`key`/`source` mappings copied unchanged. Its 53 surface candidates include file/function/test/support-document records; they are not 53 product features or assigned permanent IDs. Root owns permanent IDs and audit statuses.

Git object hashes and baseline existence were independently checked using `git cat-file blob`, including the literal `[provider]` route path. Working-tree hashes had no drift at verification (13:26:26 UTC). Disk hashes preserve actual line endings; incoming/baseline hashes cover git object bytes. Later merging may alter hashes.

This was read-only source discovery. No source, master audit, state, generator, SQL, provider configuration or dependencies changed. Function extraction covers exports and named top-level functions, not anonymous callbacks, nested functions or object methods. The snapshot neither executes the incoming API/tooling nor establishes workflow coverage; those surfaces need their own root-assigned audit records after integration.

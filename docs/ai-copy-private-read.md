# Stored AI copies and monthly request counts

Source candidate based on `f593850a47a1865f1076a8650391a382f0c5fc12`; migration `0493_ai_copy_private_read_and_quota.sql` is unapplied. No hosted configuration, migrations or provider calls are part of this change.

The effective existing policies expose another household member's `ai_requests.request_text` and `family_automation_runs.summary` to unrelated children. The tool receipt policy also permits its original user to read `ai_tool_calls.inputs/outputs` after their household membership becomes inactive. An additive restrictive SELECT boundary now requires active household membership and requester or eligible manager access. Contexts, plans, steps, events and tool receipts must follow visible ancestors within the same household. Requester member IDs resolve through their actual active member row, with user-only legacy ownership retained where the stored member ID is null. Managers retain ownerless routine/system data and approval review; migration 0477 continues protecting approval drafts.

Ordinary caller queries of AI rows now reflect that viewer's access. This affects request history, run details, home summaries and related metrics. Monthly entitlement accounting cannot use a viewer's filtered request count: a child may have zero visible sibling requests while the family has already used its allowance. `count_family_ai_requests_month` returns only an aggregate bigint over a validated UTC month `[start,end)`, including sibling and system requests. Authenticated callers require current active membership; trusted background calls require the actual database `service_role`. JWT role strings do not grant that authority. Its ACL explicitly removes PUBLIC and anon execution, including direct grants inherited from Supabase default privileges.

`assertAIAccess` calls only this RPC for finite monthly allowances. Missing RPCs, database errors, rejected transports and null, malformed, negative or unsafe count receipts deny access with the existing unavailable response. Basic/unlimited and superadmin behavior is unchanged. This remains a count-before-insert check, without an atomic reservation; simultaneous requests can still exceed a quota.

## Actual PostgreSQL verification

Run the standalone verifier against a disposable PostgreSQL cluster whose bin directory, loopback port and exact data directory are explicitly supplied:

```text
node scripts/verify-ai-copy-private-read.mjs --postgres-bin <absolute-bin-directory> --port <owned-port> --expected-data-dir <absolute-owned-data-directory>
```

The runner checks server identity before creating a uniquely named synthetic database. It extracts the relevant table DDL, extension DO block, SELECT policies and request/approval write policies from actual source migrations 0022, 0093, 0250, 0251, 0255 and 0264. Dependency tables and membership helpers are modeled; this is not a replay of the entire production catalog. It applies 0478 twice and verifies actual authenticated, anon and service roles, active requester/reviewer/system/legacy controls, requester INSERT RETURNING, service-persisted context access, existing approval cancellation/decision rules, inherited restrictions, cross-family/conflicting ancestry, exact UTC boundaries and effective direct-default ACLs. A temporary anon EXECUTE grant separately proves the actual-role guard rejects a spoofed service claim.

Two rollback controls omit 0478 and must fail at the original unrelated-child request disclosure and inactive-owner tool disclosure. All fixture data rolls back; the verifier removes only its own new synthetic database and reports source hashes. Hosted CI runs this verifier explicitly after the messaging and approval contracts; the opt-in local Vitest case is not the CI receipt.

Local receipt: PostgreSQL 17.10, Node 24.19.0, 98 successful assertions, both expected old-policy failures and rollback. Dual-household manager controls first prove the foreign request/plan/run/step is readable, then verify mismatched descendants are hidden. Migration SHA256 `af97b11d389f9559f4dd67a80976e72b709c5e166bfac2cfbb1f3add2534577a`; fixture SHA256 `8a5a1fc6c9ac0e999389b6339c4309a9cf53f80ac3a3646a3f507477398fae45`; extracted baseline SHA256 `4dd7050794e3d552a12e110a9c713e8707521bd48cb8392b945980d2159edb14`. Hosted checks use the declared Node release; local 24.19 is below the repository's 24.21 requirement.

## Remaining privacy boundaries

Eligible household managers can still read private-conversation text copied into AI requests, inputs, outputs and approvals even if they are not conversation participants. Participant-only projection/redaction is a separate unresolved product and authorization boundary. This change also does not alter the higher executor ledger's cached replay timing, previously persisted data, service-role trust, or request-count concurrency. Existing independent AI privacy candidate work is untouched.

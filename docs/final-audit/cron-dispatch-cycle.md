# JOB-001 — Required cron dispatch configuration and execution boundary

Date: 2026-09-12. Baseline: currentmain c7b56eff. Root recorded JOB-001 IN PROGRESS before these changes. Owned files: `scripts/cron-dispatch.mjs`, `.github/workflows/cron-dispatch.yml`, `tests/cron-dispatch-execution.test.ts`, and this record. No actual cron endpoint, provider, database, secret or repository setting was changed by verification.

## Baseline failure

A real CLI subprocess at `2026-09-12T12:05:00Z`, with `CRON_SECRET` unset and fetch replaced before entrypoint evaluation, reported three due routes and then:

```text
CRON_SECRET is not set — skipping (add it under Settings → Secrets → Actions).
```

It exited **0**, causing a successful job despite dispatching nothing. The workflow documentation explicitly described that behavior. The new CLI execution suite initially had **16 failing / 7 passing** cases, including absent configuration and credential-safe dispatch controls.

## Changes

- A real dispatch requires a nonblank `CRON_SECRET`; missing configuration produces a named configuration error and exit **1** without any fetch. A multiline secret is rejected before header construction. Messages do not print configuration values.
- Explicit `--dry-run` remains credential-free, prints the due route selection and performs no fetch.
- Manual `--route` must name one of the existing registered cron routes. Missing or invalid route arguments exit **2** rather than silently running all due routes or concatenating an arbitrary destination onto the base URL.
- `CRON_BASE_URL` remains optional with the same production default. Configured values must be HTTPS origins without embedded credentials, paths, query or fragment. HTTP is accepted only for loopback localhost, 127.0.0.1 or [::1], preserving local testing while keeping the dispatch secret off public plaintext connections. Invalid config exits **2** without echoing the value or sending credentials.
- Requests refuse automatic redirects; 3xx, non-2xx, network/stream errors and timeout become failed dispatch results and nonzero process exit. The existing 120-second request deadline and concurrent due-route dispatch remain intact.
- Response diagnostics read at most **4,096 bytes**, cancel the remaining body, collapse whitespace and print at most 200 characters. The configured secret is redacted from both response and thrown-error diagnostics.
- CLI entrypoint detection now uses Node's `pathToFileURL`, supporting the actual script path without manually constructing a file URL.
- Workflow comments and step name now state that configuration is validated and missing required credentials fail the job. The script's nonzero exit propagates through the existing shell step.

**No schedule or catch-up semantics changed.** All 22 entries in SCHEDULES, `TICK_MINUTES = 5`, the five-minute workflow schedule, repository restriction, concurrency policy and workflow timeout remain unchanged.

## Execution verification

```text
node node_modules/vitest/vitest.mjs run tests/cron-dispatch-execution.test.ts tests/cron-dispatch.test.ts tests/cron-schedule-registration.test.ts tests/cron-auth.test.ts
```

Final result: **4 files / 44 tests passed**, including **30 new actual CLI subprocess cases**, in 2.03 seconds. Tests inject a fetch replacement through Node's `--import` before the dispatcher module loads. They never contact the internet or invoke real cron routes.

Coverage includes missing/blank/multiline secrets, credential-free dry-run, a configured single-route dispatch, all three due routes at a fixed tick exactly once, arbitrary/unregistered/missing route arguments, malformed/credential-bearing/remote-HTTP base URL, accepted local HTTP origins for localhost/127.0.0.1/[::1], HTTP 401/403/307/500, thrown failures, reflected-secret redaction, bounded streaming response cancellation, deadline abort, and attempting the entire due set while reporting a failed tick.

The deadline case shortens only the subprocess's 120,000 ms timer to 10 ms; it still exercises the dispatcher's real AbortController and failure exit. The response limit case supplies a synthetic stream and asserts cancellation after at most six 1 KiB chunks, including prefetch, rather than buffering all 20 chunks.

```text
node node_modules/next/dist/bin/next lint --file scripts/cron-dispatch.mjs --file tests/cron-dispatch-execution.test.ts
node --check scripts/cron-dispatch.mjs
```

Results: **PASS**, no lint warnings/errors and valid Node syntax. The existing next-lint deprecation notice remains. The workflow was also parsed with the installed `js-yaml`; its schedule remains `*/5 * * * *`.

```text
node node_modules/typescript/bin/tsc --noEmit --incremental false --pretty false
```

Full strict typecheck: **PASS**. The first run caught test-environment string indexing against an overly narrow inferred object; declaring that actual process environment as `NodeJS.ProcessEnv` resolved it, and the strict rerun completed without errors. Root owns final combined full-suite/build evidence and the master audit status.

An additional direct comparison against `c7b56eff:scripts/cron-dispatch.mjs` verified that the complete SCHEDULES declaration is byte-for-byte unchanged after newline normalization; `TICK_MINUTES` remains 5. Final `git diff --check` passed.

## Remaining scheduler scope, separate from this fix

- The dispatcher uses a fixed five-minute retrospective window ending at invocation time. It does not store the previous successful tick or a per-route cursor. A delayed/missed invocation can therefore miss a daily/hourly due minute outside that window. This is a repository scheduling reliability item requiring an explicit catch-up/idempotency design; no schedules/lookback were silently changed here.
- Live GitHub Actions configuration, actual secret equality with deployment, production URL reachability and deployed handler authentication were not exercised. The CLI now fails clearly for absent config, but these tests do not establish that production secrets/settings are configured correctly.
- The dispatcher classifies completion by transport/HTTP status. The success or partial-failure semantics inside each route's JSON response and durable work must be verified in that route's workflow; HTTP 200 alone is not proof that every background action completed.
- These tests validate orchestration boundaries with synthetic responses, not actual provider delivery, database writes, cron idempotency, or worker lease recovery.

The falsely green missing-secret dispatch defect is fixed and locally retested. Production readiness remains **NO** pending the remaining scheduler and application audit workflows.

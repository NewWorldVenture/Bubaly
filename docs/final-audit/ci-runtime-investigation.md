# PERF-002 / TEST-002 — Hosted E2E runtime and fixture investigation

Date:2026-09-12. Root recorded PERF-002 and TEST-002 before configuration/fixture edits. These changes are a separate source cycle after the frozen fourth-cycle `572b29c9`; no private clean installation, global runtime, installed dependency, SQL or provider data was changed.

## Exact hosted evidence and attribution limits

Input log: `C:/Users/Daniel/AppData/Local/Temp/bubaly-social-ci-e2e-20260912.log`, hosted run34699583414. CI selected Node22 and resolved22.23.2. The browser job ran609 tests with2 workers:608 passed and one flaky Chromium first-value journey passed on retry. Its original failure was the unchanged five-second assertion for `Task saved` at `authenticated.spec.ts:115`.

At14:40:04, the server logged `families_created_by_fkey` violations for a user absent from Auth. The failed first attempt was reported around14:40:08–12. The first recorded TransformStream error was later, at14:40:45. The log contains20 `[server-error]` entries for the same internal exception/digest4176532772, all attributed to rendering `GET /`. Repeated logging does not prove20 independent broken user requests. Neither the log nor the passing retry proves these errors harmless.

The exact first-value failure remains unattributed: the saved log has no task-write HTTP timings/status and no first-attempt DOM evidence. CI uploads isolated screenshots/error-context only under `failure()`; a passing retry makes this job successful. No assertion timeout, toast assertion, persistence check or RLS probe was weakened. The account collision below is independently reproduced, but is **not claimed as the proven cause** of this particular hosted failure. The stream errors occurred later and are not claimed to explain the toast timeout.

## PERF-002: reproduced Node cancellation race

Actual source path: the homepage in `app/(marketing)/page.tsx` is rendered through Next's streaming pipeline. The installed `next/dist/server/stream-utils/node-web-streams-helper.js` exports `createBufferedTransformStream`, which `continueFizzStream` places in that pipeline. `next/dist/server/pipe-readable.js` creates an abort controller for the HTTP response and aborts piping on disconnect. Repository application code does not construct a homepage TransformStream itself.

Executing a pending read, reader cancellation and a late write against the **installed Next helper** reproduces the exact internal TypeError at `node:internal/webstreams/transformstream:527:37`. The same sequence against native TransformStream also reproduces it; React, Supabase and application data are unnecessary. This matches the upstream cancellation race, where cancellation clears `transformAlgorithm` before a queued write invokes it. Node's fix adds the missing guard. [Node PR62040](https://github.com/nodejs/node/pull/62040).

Official22.23.2 source still contains the unguarded call, while24.15.0 contains the guard. This establishes the minimum chosen runtime, rather than guessing from the major version alone. [Node22.23.2 source](https://raw.githubusercontent.com/nodejs/node/v22.23.2/lib/internal/webstreams/transformstream.js), [Node24.15.0 source](https://raw.githubusercontent.com/nodejs/node/v24.15.0/lib/internal/webstreams/transformstream.js).

| Identical25-trial harness | Node22.23.1, existing local runtime | Node24.21.0, isolated official runtime |
| --- | ---: | ---: |
| Native TransformStream internal errors |25/25|0/25|
| Installed Next15.5.25 buffering transform internal errors |25/25|0/25|

The portable executable was downloaded only after root authorized the isolated comparison:

- Path: `C:/Users/Daniel/AppData/Local/Temp/bubaly-node24-perf002-20260912-v24.21.0/node.exe`.
- Official artifact: `https://nodejs.org/dist/v24.21.0/win-x64/node.exe`.
- Verified SHA256: `ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32`, matching the versioned official `SHASUMS256.txt` before execution. The checksum file is retained beside the executable.
- Comparison harness: `C:/Users/Daniel/AppData/Local/Temp/bubaly-ci-runtime-investigation-20260912.cjs`. It uses source-defined fixture hooks and installed Next code, with no network or database operations. Its original account-deletion assertions characterize the pre-fix fixture and should not be used as post-fix expectations; committed tests below assert isolation instead.

The actual hosted client-disconnect sequence has not been replayed against the complete production homepage in this lane. This is a deterministic actual-runtime/module reproduction, not a complete hosted-page reproduction or a claim that all future streaming errors disappear.

## Runtime configuration repair

Root `package.json` now requires `>=24.15.0 <25`; only the corresponding root-package metadata was added to `package-lock.json`. No dependency version, integrity or resolved URL changed. CI's web quality and E2E jobs use Node24. The separately managed mobile job remains on22. No optional runtime file or monkeypatch was introduced.

Next15.5.25's official package declares Node `^18.18.0 || ^19.8.0 || >=20.0.0`, which includes24. Vercel officially supports24.x and permits a package-engine semver range to override the project-selected runtime. Its platform selects major versions and supplies patch updates, so the deployed runtime must still be verified by the combined/deployment gate. [Next15.5.25 package](https://raw.githubusercontent.com/vercel/next.js/v15.5.25/packages/next/package.json), [Vercel runtime selection](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions).

`tests/stream-cancellation-runtime.test.ts` runs native and installed Next transforms with the race ten times each. Both cases **fail under22.23.1** and **pass under the checksum-verified24.21.0**, without changing Next or application code. They retain ordinary cancellation/rejection semantics while rejecting the internal controller error.

## TEST-002: actual fixture ownership collision and repair

`playwright.config.ts` runs the authenticated spec in both Chromium and iPhone projects with two workers. Serial mode inside the spec does not serialize separate project/worker modules. Previously each module used the same global `E2E_AUTH_EMAIL`; `beforeEach` searched that email, deleted its family and Auth user, then created a new user. `afterEach` also deleted that shared identity.

The read-only harness executed the actual unmodified hooks in separate VM modules backed by one synthetic Auth/family store. Chromium created a user and active family. iPhone setup then deleted both before creating its own replacement. The same collision reproduced for different workers of one project and a new attempt at the same project/worker identity. This can invalidate another ongoing journey, independently of the original hosted flake's unknown timing.

The fixture now allocates a fresh email for each setup from the base email's domain and a hash binding base email, project, worker index and random attempt nonce. Cleanup can search only that allocated email, verifies the returned user's email before deleting any household/account, and clears its local ownership fields afterward. The shared base address is never an owned cleanup target. The login/onboarding/task-save assertions and isolated RLS probes remain unchanged.

`tests/authenticated-fixture-ownership.test.ts` executes the source-defined hooks rather than a copied cleanup implementation. Three interleavings prove that the first fixture's user/family survive the second fixture's setup and cleanup. A fourth case proves that a mismatched Auth response cannot authorize deletion. All four cases failed before the fixture correction and pass afterward. The synthetic store applies the actual queries and identity deletes; live Supabase/browser timing remains for root's gate.

## Focused verification and remaining work

```powershell
& 'C:/Users/Daniel/AppData/Local/Temp/bubaly-node24-perf002-20260912-v24.21.0/node.exe' node_modules/vitest/vitest.mjs run tests/stream-cancellation-runtime.test.ts tests/authenticated-fixture-ownership.test.ts tests/capture-save.test.ts --reporter=dot
```

**3 files /17 tests PASS**, including6 new regressions;0.47 seconds. The six new cases were explicitly red under the old runtime/fixture before repair. Scoped ESLint for the new regressions and modified authenticated spec **PASS**. Package/lock root-engine values match; `git diff --check` **PASS**.

Root owns the full Node24 build/type/unit/browser validation and deployed runtime verification. The exact hosted first-value toast failure still needs a subsequent isolated run or bounded failure diagnostics if it recurs; account isolation and runtime repair do not justify declaring that original failure explained. No live OAuth, message, database or provider operation was performed in this investigation.

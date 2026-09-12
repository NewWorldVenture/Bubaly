# Hosted login, meals and Guardian acceptance

Publication: `0b1906593adee286e59a8330311e74ad43cdfef4`.
Application source: `48e7e9e1939c8f4be2e4f70d283606ef29f5807c`.
Main integrated through: `217c7be464c30f4f10a1bf672a07b5a9fca67e6a`.

[CI 34715644176](https://github.com/NewWorldVenture/Bubaly/actions/runs/34715644176) completed successfully on 2026-09-12 at 20:11:14 UTC. Its checkout was merge `7f132c92db9969b4a902e7fc027086a59015ba0e`, with tree `d4c1fc3c661c7b7323930e8ada1268bdb91fc979`, identical to the published head. Both the PR trigger and actual tested source are recorded to avoid confusing a PR head with the CI merge checkout.

- Web quality job `103612370554`: 1,188 files and 14,442 unit tests pass; production build completes 251 pages; strict types, lint, localization and query audits pass. Query inventory: 491 tables, 77 functions and 142 routes.
- E2E job `103612370702`: 1,061 scheduled tests and 1,061 passes in 6.5 minutes; no failed, flaky or skipped summary. Both authenticated and durable-session flags were enabled.
- Database job `103612370707`: 300 existing migrations replay with zero failures; all 11 boundary probes pass.
- Mobile job `103612370387`: passes.
- [Finance run 34715644149](https://github.com/NewWorldVenture/Bubaly/actions/runs/34715644149), job `103612271314`: 66 assertions pass.
- Vercel deployment `2FHEa8zJQPpCedFLsb6djEQSqPZc`, GitHub deployment `6413783281`: succeeds for this exact publication. [Preview](https://bubaly-pdfponx09-newworldventure.vercel.app/dashboard/meals).

The exact tested tree includes three Guardian receipt-authority cases, two child readiness cases, five durable login cases and the complete meal and grocery journey. The GitHub reporter does not print each successful case. Inclusion is established by source discovery, enabled flags, and equality of the scheduled and passed totals, rather than invented individual pass log lines.

Sanitized local proof: `C:/Users/Daniel/AppData/Local/Temp/bubaly-0b190659-hosted-e2e-proof-20260912.log`. It retains checkout identity, enabled flags and test totals; no user payloads or credentials.

This checkpoint verifies the preceding application batch. The subsequent autonomous SMS recovery cycle changes the receipt lifecycle and shared processing, so its new source and hosted journey require their own checks. Production session policies, physical devices, provider delivery, unresolved authorization failures and the second comprehensive regression remain outside this acceptance. Production readiness remains NO.

## Autonomous recovery acceptance at fae35e90

Publication `fae35e90c0c7705a870f11d6666ee16424975411` passes [CI 34717274616](https://github.com/NewWorldVenture/Bubaly/actions/runs/34717274616), completed at `2026-09-12T20:43:31Z`. The actual tested checkout is `62d8a325bfcb5e805dc9c299fd03034a0eabd5e2`, a merge into `fdce273b`. Its tree `bb838fce7962c4037cc695d4dbf6cbb2758a2411` exactly equals the published tree.

- Web job `103616659899`: 1,194 files and 14,636 unit tests pass; production build generates 252 pages; types, lint and query checks pass. Query coverage is 491 tables, 77 functions and 143 API routes.
- E2E job `103616659963`: 1,062 scheduled tests and 1,062 passes in 6.5 minutes, with no failed, flaky or skipped summary. Authenticated and durable-session flags are enabled. Exact-tree discovery establishes all twelve focused cases: three Guardian authority cases, one autonomous recovery case, two child-readiness cases, five durable login cases and the complete meal/grocery case. No individual successful-case log lines are claimed.
- Database job `103616659766`: 300 migrations replay without failure and all eleven boundary probes pass. Mobile job `103616659880` passes. [Finance run 34717274596](https://github.com/NewWorldVenture/Bubaly/actions/runs/34717274596) passes 66 assertions.
- Vercel deployment `7FNY9gQT2ow5wJid4Csjw3WWwKZi` succeeds at `2026-09-12T20:32:41Z`. [Verified preview](https://bubaly-e5yu9w5dl-newworldventure.vercel.app/dashboard/meals).

The new recovery case verifies retained signed intake after a policy failure, child denial of receipt creation, cron authorization, recovery without another provider callback, untouched unreceipted member content and repeated-sweep idempotence against real disposable PostgreSQL and HTTP. The final clean sweep also exercises the actual cursor continuation query. It does not verify a production scheduler or provider delivery.

Sanitized checkout/count evidence: `C:/Users/Daniel/AppData/Local/Temp/bubaly-fae35e90-hosted-{web|e2e}-proof-20260912.log`. The separate Contact Center automatic-reply reservation source introduced after this publication requires new hosted acceptance.

## Single-reply reservation acceptance at 5648447c

Publication `5648447cff4352d6f3dde6a5460a0eb0983dbc5c` passes [CI 34718134835](https://github.com/NewWorldVenture/Bubaly/actions/runs/34718134835), completed at `2026-09-12T21:02:43Z`. The actual checkout is `36e2270815449c2e5dc1dcf43bcd70c84af76229`, merging this head into `fdce273b`. Its tree `cc4146dbef9714f3c9a69b083d2c3e20653fbd64` exactly equals the published tree.

- Web job `103618933570`: all 14,761 unit tests in 1,197 files pass; production build completes 252 pages; types, lint and query checks pass. The query audit resolves 491 tables, 77 functions and 143 API routes.
- E2E job `103618933574`: 1,063 scheduled tests and 1,063 passes in 7.8 minutes, with no failed, skipped or flaky summary. Authenticated and durable-session flags are both enabled. Exact-source discovery includes thirteen focused cases: the new Contact Center single-reply reservation case, three Guardian receipt cases, one autonomous recovery case, five durable-login cases, two child readiness cases and the complete meal/grocery journey. Successful-case lines are not emitted by the reporter; discovery, enabled flags and matching scheduled/passed counts establish inclusion.
- Database job `103618933537`: 300 migrations replay with zero failures and all eleven boundary probes pass. Mobile job `103618933468` passes. [Finance run 34718134817](https://github.com/NewWorldVenture/Bubaly/actions/runs/34718134817), job `103618933453`, passes 66 assertions.
- Vercel deployment `D5xyVTdPBXqbuYRGkUghkaspxWQJ` succeeds at `2026-09-12T20:49:48Z`. [Verified preview](https://bubaly-mwqvag0y5-newworldventure.vercel.app/dashboard/meals).

The new reservation case proves one reply for repeated and concurrent signed requests, one deterministic outbound projection, preservation of archive state, and child denial of private receipt insertion against disposable PostgreSQL and real HTTP. It does not exercise real SMS delivery. The subsequent signed delivery-status source requires its own hosted acceptance.

Sanitized proof: `C:/Users/Daniel/AppData/Local/Temp/bubaly-5648447c-hosted-{web|e2e}-proof-20260912.log`. Production settings, live providers, physical devices, unresolved authorization defects and the second complete regression remain outside this checkpoint.

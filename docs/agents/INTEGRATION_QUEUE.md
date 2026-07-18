# INTEGRATION_QUEUE

Repo policy: validated increments are rebased on latest `main` and pushed
directly to `main` (no long-lived integration branch). So this queue tracks
recent validated increments and their integration state rather than a staging
backlog.

| Increment | Agent | Commit | Validation | Integrated to main | Verified |
|-----------|-------|--------|-----------|--------------------|----------|
| notes duplicate/pin write guards | QA-01 | 2923b476 | vitest 4/4, eslint, tsc | yes | yes |
| pets deleteRecord guard | QA-01 | 7f8ceedb | vitest 1/1, eslint | yes | yes |
| autopilot+voting write guards | QA-01 | cc82bf2d | vitest 4/4, eslint | yes | yes |
| routines wholesale-replace guard | QA-01 | a34c833d | vitest 2/2, eslint | yes | yes |
| §3b crash sweep + class docs | QA-01 | 8e8d0c47 | read-only sweep | yes | yes |
| next build gate GREEN | QA-01 | c236f344 | next build exit 0 | yes | yes |
| Concierge + Briefing + Graph reasoning read boundaries + Windows test guards | CODEX-01 | fba93554 | 619 Vitest files / 3,690 tests, lint, tsc, fresh 250-route build, remote readback | yes | yes |
| Decisions + Outcomes + Playbook + Prep Plans reasoning read boundaries | CODEX-01 | 59ef1633 | 627 Vitest files / 3,721 tests, lint, tsc, fresh 489-route build; focused 4/4 tests | yes | yes |
| Unified reasoning source-failure contract | CODEX-01 | this publication | 629 Vitest files / 3,726 tests, lint, tsc, fresh 489-route build; focused 13/13 tests | pending | pending |
| Closed-loop marketing control-plane audit | CODEX-01 + MARKETING lanes | c0e37f7f | 631 Vitest files / 3,734 tests, marketing 46 files / 245 tests, lint, tsc, fresh 489-route build | yes | yes |

Nothing is currently awaiting integration from QA-01.

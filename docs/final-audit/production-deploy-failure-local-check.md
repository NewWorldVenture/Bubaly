# Production deploys of main fail on Vercel: not reproducible from the repository

Date: 2026-10-29. Checked against main `5733d36` and production's commit `d93e089`. Root owns the release gate and its status; this records what a local reproduction can and cannot show.

## What is failing

Production still serves `d93e089` (`/api/build-info`), 219 commits behind main. The ledger records each later automatic production deployment of main as failed, with the cause unknown, because GitHub shows only a generic failure and the build logs are not visible to the audit lanes. Two of them:

| Main commit | Pushed | Vercel deployment | Failed |
|---|---|---|---|
| `b10da29` | 2026-10-27 19:54:00Z | `BVezktzRnDCzDGNYFP5XmQsxRrn1` | 19:57:07Z |
| `5b342e2` | 2026-10-27 23:12:49Z | `dpl_5rMGYnfgdNTvnXzaJVkRNUdBHorF` | 23:15:16Z |

Both failed about three minutes after the push. That is too late for an upfront rejection, and early in the build (a cold compile alone takes over five minutes locally).

## What builds locally

All of the following pass on main `5733d36`, from a clean checkout and `npm ci`:

- **Vercel's own build.** `vercel build --prod` with Vercel CLI 65.8.0 and the project's IDs runs Vercel's install, `npm run build` (Next.js 16.4.2, webpack) and Vercel's packaging: "Build completed successfully". Nothing is deployed.
- **Function sizes**, summed from each function's file map (unzipped): the largest is 114.3 MB (`_not-found`), then 48.0, 45.7, 45.1, 43.8, 43.8 and 33.9 MB; middleware is 2.0 MB on `nodejs24.x`. Vercel's limit is 250 MB.
- **Build memory**, the summed RSS of the build's whole process tree: main 5.8 GB cold, and 6.4 GB warm from `d93e089`'s `.next/cache` (as Vercel restores it). `d93e089`, which deployed, peaked at 6.8 GB cold. Vercel's standard build machine has 8 GB.

## What did not change between `d93e089` and main

- `package.json`, `package-lock.json` and `.nvmrc` (24.21.0) are identical. There is no `.npmrc`. Every dependency commit is older than `d93e089`.
- `vercel.json` has not changed since 2026-10-04 (28 crons on both).
- Route segment config is identical: 280 `force-dynamic`, 116 `runtime = 'nodejs'`, and the same `maxDuration` values (60 ×19, 300 ×12, 120 ×5, 110 ×3).
- `next.config.mjs`, `lib/build-identity.mjs` (which cannot throw) and `lib/security/csp.mjs` are unchanged. No code that runs at build time throws on a production-only environment variable.
- The largest tracked file is `finalaudit.md` at 17.4 MB; the whole tree is 104.3 MB.

## So the cause is on Vercel's side

What fails is something only the Vercel project holds:

- production environment variables read during the build;
- project settings that override the repository (install or build command, Node.js version, root directory);
- a damaged build cache;
- account state.

**The one thing needed is a failed deployment's build log**: in the Vercel dashboard for team `newworldventure`, project `bubaly`, under Deployments, the failed deployment, then Build Logs. If the log points at the cache, *Redeploy* the latest main with *Use existing Build Cache* unchecked.

Limits of this check: it ran in a Linux container, not Vercel's build image, and with the CI-style local environment, not production's variables.

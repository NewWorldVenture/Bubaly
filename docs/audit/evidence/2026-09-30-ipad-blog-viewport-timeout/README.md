# iPad /blog `setViewportSize` timeout: investigation (2026-09-30)

Evidence for the one-off CI failure `[ipad] › overflow.spec.ts › /blog fits every width`:
`page.setViewportSize: Test timeout of 30000ms exceeded`. It passed on retry, so it is **flaky**, not fixed.
It was seen once, in run 36733754435 on `a928852a` (#668). In the 10 E2E runs sampled from
2026-09-30, there were no other occurrences.

**This directory does not prove the cause of that CI instance.** CI keeps no trace of it: traces are
recorded on the first retry only, and uploads exclude traces and auth state (unchanged). What is below:
- measures where the test's time goes;
- rules out a CSS or overflow defect;
- reproduces the exact CI error locally, with the real test, through one mechanism: a stalled data API
  holding /blog's navigation open;
- shows the fix on this branch removes that mechanism.

## What the failure says

- **The deadline is the test's, not the resize's.** The 30 s is the **whole test's** budget: `goto` (to
  `domcontentloaded`), then four resizes, each followed by a frame. The error names only the call in
  flight when the budget ran out.
- **The assertion never ran.** Nothing here says the page overflowed.
- **CI's server log for that 30 s window** (about 15:33:39 to 15:34:09 UTC) shows only aborted RSC
  prefetches of header links (`The destination stream closed early`), which are routine when a page
  closes mid-prefetch. There are no `[blog] getAllPosts failed` or marketing read timeouts. Reads that were
  slow but still completed would not be logged.

## Setup

| | |
|---|---|
| Source | `main` at `e5b39c91` (production build, `next start`, as CI runs it) |
| Data | The local Supabase stack with all migrations; 1,048 published `blog_posts` rows, and /blog renders 25 |
| Browser | Playwright 1.61.0, pinned Chromium 149.0.7827.55 (build 1228), headless, the repository's device descriptors |
| Machine | 4 CPUs, the same count as CI's runner |

**The probe** (`probe/probe-viewport.spec.ts`) asserts nothing. For each route it records:
- the `goto` duration;
- a renderer round trip before each resize (`ping`);
- each `setViewportSize` call;
- the next animation frame;
- long tasks, DOM size and in-flight requests.

`probe/summarize.py` prints the median, p90 and maximum in milliseconds. All raw rows are in
`measurements/*.jsonl`; they hold only route paths and timings.

## Results: iPad, milliseconds as median / p90 / max

| Condition | Route | Whole test | `goto` | Largest resize | Frame after resize |
|---|---|---|---|---|---|
| Unloaded (×10) | /blog | 2125 / 2288 / 2288 | 652 / 728 / 728 | 154 | 272 median |
| Unloaded (×10) | / | 1870 / 2085 / 2085 | 437 / 719 / 719 | 131 | 276 median |
| CI-like matrix: 8 device projects, 15 routes, 2 workers (×3) | /blog | 2694 / 3049 / 3049 | 770 / 1023 / 1023 | 392 | 343 median |
| 6 busy loops on 4 CPUs, 2 workers (×8) | /blog | 4147 / 4292 / 4292 | 1268 / 2041 / 2041 | 647 | 156 median |
| Gateway paused 1.2 s of every 1.5 s (×3) | /blog | 2049 / 3218 / 3218 | 646 / 1787 / 1787 | 112 | 282 median |
| **Gateway paused for 60 s** | **/blog** | **timed out in `goto` at 30 s** | **did not return** | — | — |
| Gateway paused for 60 s | /pricing | 20913 | 20199, returned when the gateway resumed | 74 | — |
| Gateway paused for 60 s | / | 2830 | 1608 | 55 | — |

**Server time to first byte** (`curl`):
- With the data API healthy: /blog 0.10–0.41 s; `/`, /pricing, /faq, /features and /contact 0.03–0.07 s.
- With the gateway paused, measured to 100 s:
  - `/` and /faq answer in about 1.5 s. Their optional reads use `AbortSignal.timeout(1500)`.
  - **/blog and /pricing send nothing for 100 s.**
  - Both answer in 0.2 s as soon as the gateway resumes.

## What this shows

1. **Browser responsiveness does not explain a 30 s stall.** On /blog the frame after a resize is
   heavier than on most pages (about 300 ms, against 50–90 ms), and so are its long tasks (about
   0.6 s in total). But under the harshest load measured here (full CPU saturation plus the device matrix),
   the whole test stayed at or below 4.3 s and no single resize exceeded 0.65 s.
2. **Navigation is the unbounded phase.**
   - /blog's list reads carry no deadline: `lib/blog/posts.ts` (`fetchAllPublishedRows`, which is three
     sequential pages for 1,048 rows, plus `getFeaturedPost`, `getPostsByCategory`, `getPost` and
     `getRelatedPosts`).
   - While the data API stalls, the /blog navigation stays open for the whole stall, which here was over 100 s.
   - A stall of about 25–29 s would let `goto` return and leave the budget to run out inside the next
     call, `setViewportSize`. That is the CI signature. **It is consistent with the failure; it is not
     proven for that instance.**
3. **The same class of wait exists on /pricing,** through `lib/server/feature-tiers.ts`
   (`readFeatureOverrides`, which has no deadline). That helper is shared with the signed-in app, so it
   is reported here and not changed on this branch.
4. **Nothing here points to CSS overflow,** and no test timeout was raised.

## Reproducing the CI error, and the fix

**Method.** `probe/signature.sh` runs the real `tests/e2e/overflow.spec.ts` `[ipad] /blog fits every
width` test with retries 0. It pauses the Supabase gateway before the test starts and resumes it a set
number of seconds after Playwright launches; the test itself starts about 2–3 s after launch. It
compares unfixed `main` (`48d3769c`) with this branch, both as production builds against the same
stack. Results: `measurements/ci-signature.txt`.

| Gateway resumed after | `main` | This branch |
|---|---|---|
| 28–29.5 s | passed, in 28.8–30.2 s | passed, in about 9 s (28 s) |
| 30–32 s | **failed with a 30 s test timeout** (5 of 5) | passed, in 9.1–9.4 s (30 and 32 s) |

**On `main`, the call in flight** when the budget ran out:
- 31.5 s: `page.setViewportSize: Test timeout of 30000ms exceeded`, which is **CI's exact error**;
- 30, 31 and 32 s: `page.evaluate` (the frame wait or the width measurement right after a resize);
- 30.5 s: no call named.

Which call is named depends only on where the 30 s ran out once `goto` returned.

**The fix.** `lib/blog/posts.ts` now bounds every read to 4 s. The budget is passed as the query's own
abort signal (as `lib/marketing/seo.ts` does), so the SDK's retry backoff ends with it too. Under a full
stall /blog answers in about 8 s with an empty list, logged. The 8 s is two budgets in sequence:
`getFeaturedPost` falls back to `getAllPosts` after its own read times out.
`tests/blog-reads-have-a-deadline.test.ts` covers all seven reads; all 8 of its cases fail against the
previous source.

**Not changed:**
- /pricing still waits unboundedly on `lib/server/feature-tiers.ts`, which the signed-in app shares;
  it is reported, not changed here.
- No test timeout changed.

## Limitations

- **Environment.** Local Linux container; the stalls are Docker `pause` on the Supabase gateway. CI's
  data-API behaviour at 15:33 UTC is unknown.
- **Sample size.** The probe runs are small (3 to 10 per condition). They show where time goes, not a
  failure rate.
- **Emulation.** iPad is emulated in Chromium, not WebKit.

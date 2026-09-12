# Public navigation dependency cycle — UI-002

Date: 2026-09-12. Baseline: `c7b56eff`, built from a private clean install at `C:/Users/Daniel/AppData/Local/Temp/bubaly-audit-clean-install-20260912`. The root-owned bounded runner served production Next on `127.0.0.1:3117`; browser tests used `localhost:3117`. The fixture uses an intentionally unreachable Supabase URL and non-secret anonymous credential; provider/service credentials were blank. No live database or provider write was performed.

## Baseline browser reproduction

The existing `tests/e2e/marketing-public.spec.ts:55` feature-link case failed its five-second URL assertion, staying at `/` instead of `/features#smart-calendar`. The header route-change case showed the same symptom. A fresh Chromium context then executed the real page and link while collecting click, console, page-error, request/response and service-worker state:

| Observation | Actual execution evidence |
| --- | --- |
| Home document | Completed after 14,757 ms; browser loaded the expected homepage. |
| Feature anchor | Correct `href=/features#smart-calendar`; the click reached the anchor and Next prevented the browser default to perform client navigation. |
| Hydration | No `pageerror` or hydration diagnostic was emitted. The link handler executed. |
| Destination RSC request | Response headers arrived in approximately 8 ms, HTTP 200, `text/x-component`; response body remained pending for 14,167 ms. |
| URL after click | Still `/` at five and ten seconds; `/features#smart-calendar` by fifteen seconds, with destination heading `What Bubaly handles`. |
| Service worker | No controller in the fresh context; response was not from a service worker. |

This reproduces a server-render dependency stall. It does not show an incorrect href, missed click, hydration failure, hostname connection failure, or PWA interception. No navigation/layout/shared-header code was changed.

## Proven dependency cause

`app/(marketing)/features/page.tsx` and the homepage await `resolveMarketingMetadata`, which reads platform SEO and then legacy SEO in `lib/marketing/seo.ts`. Their `MarketingAeoSection` awaits the path reader in `lib/marketing/aeo.ts`, which reads canonical questions and then the page payload after a read failure.

The clean install resolves `@supabase/supabase-js` and `@supabase/postgrest-js` to **2.108.2**. The installed `PostgrestBuilder` retries eligible transport errors three times, with one-, two- and four-second waits. The baseline helpers did not provide a signal or a read budget. Two sequential failed queries therefore take approximately fourteen seconds before returning the existing optional-content fallback. The production server log confirms `ENOTFOUND audit-fixture.invalid` for both AEO reads.

An independent Node execution transpiled the actual baseline SEO/AEO helpers and loaded the actual installed Supabase SDK. Only fetch was replaced with an immediate transport failure; the Next cache boundary was an identity adapter. Both helpers ran concurrently and each returned after **14,127 ms**, with the same fallback as the production request. The sixteen total fetch attempts occurred at approximately 0, 1, 3, 7 seconds for primary reads and 7, 8, 10, 14 seconds for compatibility reads. No external network request was made by this controlled probe.

## Fix

`lib/marketing/seo.ts` and `lib/marketing/aeo.ts` now use a **1,500 ms budget per logical public read**, passed to the actual query builders with `.abortSignal(signal)`:

- Platform and legacy SEO share one signal. An exhausted primary budget prevents starting the legacy read.
- Canonical path AEO and its page-payload compatibility read share one signal. An exhausted primary budget prevents starting the compatibility read.
- Category AEO and its published-question fallback share one signal. The existing behavior retaining category rows while reporting `available: false` on fallback failure is preserved.
- Standalone published AEO reads receive the same deadline.

Configured content, metadata defaults, successful empty canonical results, legacy compatibility, and AEO availability/error semantics remain intact. Cache wrappers were unchanged: an unavailable result is still thrown inside the cache callback and converted to the render fallback outside it. No failure was made cacheable by this patch.

The timeout includes SDK retries and retry waits, rather than merely racing the returned promise while leaving work running. The SDK releases its backoff wait when the signal aborts; subsequent calls to native fetch with that already-aborted signal reject before network work begins. The SDK may make those immediate aborted fetch calls because a timeout reason is `TimeoutError`; they do not extend the budget or issue another transport request.

## Verification

`tests/marketing-public-read-budget.test.ts` executes the real helpers and installed SDK with controlled fetch responses and real timers. It does not replace the Supabase query builder or its retry implementation. The twelve cases cover:

- Simultaneous SEO/path-AEO transport failure during real retry backoff.
- A pending request that remains unresolved until cancellation, retaining authored metadata.
- A retryable 503 response with a thirty-second `Retry-After`, cancelled within the read budget.
- Primary reads consuming 900 ms before SEO/AEO compatibility reads hang, proving the remaining budget is shared.
- A 900 ms category read followed by an unavailable published fallback, retaining category rows.
- Standalone published and category transport failure.
- Configured platform SEO, legacy SEO, canonical AEO rows, authoritative empty AEO, legacy AEO after a primary error, subsequent recovery, and category deduplication.

The test fetch reproduces native fetch's immediate rejection for an already-aborted signal before recording transport work. The Next cache boundary is an identity adapter: the recovery assertion verifies callback error/fallback and a subsequent fresh read, **not actual Next cache persistence or invalidation**.

```text
node node_modules/vitest/vitest.mjs run tests/marketing-public-read-budget.test.ts tests/marketing-aeo-locale-fallback.test.ts tests/marketing-aeo-closed-loop.test.ts tests/marketing-static-aeo-coverage.test.ts
```

Result: **4 files / 33 tests passed**, including 12 new SDK execution cases, in 11.78 seconds. Focused ESLint on both helpers and the new test, plus diff whitespace checking, passed. Full-project `node node_modules/typescript/bin/tsc --noEmit --incremental false --pretty false` completed with exit 0 and no diagnostics after the helper changes and execution test were present.

The independent real-SDK outage probe was repeated against the fixed helpers. Measured from before module transpilation, SEO returned `null` at **1,565 ms** and path AEO returned `{ questions: [], available: false }` at **1,576 ms**. Only four transport attempts occurred: the two primary reads at approximately 77 ms, then their first retries at 1,078 ms. Neither compatibility lookup began after cancellation.

Root rebuilt the private production fixture with the two helper changes, then ran a bounded server with an explicit non-secret dummy service key. Fresh actual Chromium checks passed the previous five-second navigation budget:

| Fixed production check | Observed result |
| --- | --- |
| Desktop feature-card click | `/features#smart-calendar` committed in **1,654 ms**, expected destination heading present; no service-worker controller or page/hydration error. |
| Mobile menu route change | `/features` committed in **1,595 ms**, expected heading present, mobile menu closed, no page error. |
| RSC response | HTTP 200 `text/x-component` headers in 7–8 ms. Some response streams remained pending at approximately 2.1 seconds, but route commit no longer waited for them. |
| Fresh homepage load | **7,632 ms**; other optional server readers still have separate latency. |

The mobile check used the repository's actual accessible labels (`Toggle menu`, `Mobile navigation`, `What Bubaly handles`). Two exploratory probes initially used incorrect guessed labels and timed out; those harness locator errors were corrected and are not application-failure evidence. The concurrent root-owned browser matrix caused a local `/api/mkt/track` 429 console resource error in the desktop context; this was separate from hydration and navigation.

The two targeted production navigation workflows now pass in the outage fixture. The larger matrix and all configured-provider/public workflows are not implied passing by these checks; root owns the combined browser result.

## Separate fixture failures and remaining limits

The baseline runner deliberately blanked `SUPABASE_SERVICE_ROLE_KEY`. The server log shows `/pricing` render errors with `supabaseKey is required`; the footer/social-link reader logs the same configuration failure. Thus `/pricing` language-bar absence in this run is error-boundary/configuration evidence, not a proven responsive layout defect. Local `/api/exit-intent/resolve` and `/api/mkt/track` also returned 500 in this fixture. Pricing was not edited.

The baseline matrix hit the root-owned ten-minute watchdog around 98 of 425 cases; it is an incomplete browser run, not a 425-case verdict. The server was stopped by its owner/runner, and no duplicate was launched.

The 1,500 ms value is an explicit availability tradeoff for optional editorial overrides: a slower healthy read can show authored SEO or omit unavailable answers for that render. Real configured database latency, cache invalidation after an editorial write, and full multilingual content remain external/integration verification work. `localizeAeoQuestions`, social links, public statistics, case studies and other marketing readers are outside this proven fix; their independent latency or configuration behavior must not be inferred passing from these tests. Translation and admin write paths were untouched.

## Follow-up: optional social-profile read

The remaining fresh-home delay was reproduced through the actual installed Supabase SDK in tests/social-links-read-budget.test.ts. With the original public cached reader, an immediate transport failure returned after **7,049 ms**, failing the 2,500 ms assertion. The query runs in both the public footer and structured data.

The private cached read in lib/server/social-links.ts now carries a 1,500 ms abort signal through SDK retries and backoff. It continues throwing failures inside the cache callback and catches them outside, retaining successful empty settings and sanitized configured links. The admin read/write paths are unchanged.

The four new execution cases cover seven-second retry backoff, a hanging transport followed by successful recovery, a 503 Retry-After of 30 seconds, and authoritative empty settings with the exact social_links filter. All **3 related suites / 36 assertions PASS**, and scoped lint passes. Next cache is an identity adapter in these tests; actual cache storage and admin invalidation remain separate verification.

Before this additional social-read patch, the private production fixture completed all **104 selected Chromium public, mobile, overflow, accessibility, CSP and marketing interaction checks** in 3.6 minutes. This is a selected matrix, not the earlier incomplete 425-case run. A combined production build/browser check including the social-read patch remains pending.

# API, server action, service, authentication and AI discovery

Baseline: currentmain c7b56eff. Discovery date: 2026-09-12. This is source discovery and narrow local executable verification. No production source, migrations, dependencies or external provider state was changed during discovery. No repository AGENTS.md was found; the global C:/Users/Daniel/.codex/AGENTS.md was empty.

Subsequent local fixes/retests for API-DISC-F01–F03 are recorded in [contact-center-cycle.md](../contact-center-cycle.md). The findings below preserve baseline evidence; they are not a claim that those three defects remain unfixed.

## Complete syntax inventory

[api-inventory.json](api-inventory.json) contains every route/HTTP export, every exported function in a top-level `use server` module, the inline server action, all `lib/services` runtime exports, and supplemental library/AI surfaces. Modules include line references, static import callers/tests, local permission calls, table/RPC names, provider imports, validation and mutation evidence. API records also contain literal URL callers and test references. The 118 discovery groups collect those surfaces by domain; they are not verified audit outcomes.

| Surface | Count |
|---|---:|
| Source files parsed with TypeScript AST | 2,692 |
| Route files | 137: 135 `/api` and 2 `/auth` |
| Explicit HTTP handlers | 145: 95 POST, 50 GET |
| Top-level `use server` modules | 124 |
| Exported server-action functions | 481 |
| Additional inline server action | 1 |
| `lib/services` modules | 49 |
| Exported service functions | 262 |
| Service runtime export entries | 295 |
| Supplemental lib modules/runtime exports | 716 / 3,529 |
| AI/orchestration modules in supplemental inventory | 135 |

No route file lacks a recognized HTTP export. Counts exclude implicit framework HEAD/OPTIONS behavior. Tables are literal `.from` calls, which can also name storage buckets. Computed calls, dynamic imports, RPC internals, deployed RLS and provider configuration require further workflow tracing. Local gate evidence does not establish enforcement on every branch. Supplemental exports are syntax entries, not assertions that every export is remotely callable. Referenced tests are not pass claims.

## Highest-priority workflow: Contact Center inbound delivery

Expected chain: provider callback → middleware → secret/signature verification → bounded parse and family resolution → AI summary → durable inbox record → idempotent planner/paperwork handoff → escalation/reply → provider acknowledgement → inbox UI. Relevant tables include `families`, `family_contact_channels`, `family_inbox_messages`, `ai_requests`, `family_automation_runs`, `paperwork_items`, `notifications`, and document/attachment records. Providers include Twilio, inbound/outbound email and the configured AI provider. UI/actions include `components/contact-center` and `app/(app)/dashboard/contact-center/actions.ts`.

### API-DISC-F01 — HIGH: Middleware blocks all four provider callbacks

- Source: `middleware.ts` PUBLIC array and `isPublic` prefix check; `app/api/contact-center/{email,sms,voice,voice/transcription}/route.ts`.
- `/api/contact` is public only for that exact path or `/api/contact/…`; it does not cover `/api/contact-center/…`. All four callbacks are absent from PUBLIC. Providers have a signature/shared secret and no Supabase user cookie, so middleware redirects valid deliveries before route authorization executes.
- Executed current middleware through TypeScript transpilation with real installed `NextRequest`/`NextResponse`, dummy config and Supabase `getUser` mocked signed out. All four paths returned **307 to /login**. Controls `/api/contact`, `/api/guardian/inbound/sms`, `/api/webhooks/stripe` returned **200, x-middleware-next: 1**. No network/provider writes.
- Fix/retest: add narrowly scoped callback reachability; execute middleware tests for these four paths and neighboring private paths; execute secret/signature rejection tests so reachability preserves authorization.

### API-DISC-F02 — HIGH: SMS/voicemail lose planning work after partial failure

- Source: SMS and voicemail transcription handlers' `filed.inserted` blocks; `lib/contact-center/server.ts` `routeInboundToPlanner`.
- Planner intake returns `no_scope`/`intake_failed` on expected failures and stamps `ai_handled` only after successful intake. SMS ignores failure outcomes, catches thrown failures and acknowledges with 200. On replay the inbox row already exists, `inserted=false`, and the handoff never retries. Voicemail uses the same pattern.
- Executed SMS handler with real `NextRequest`/`NextResponse` and mocked DB/providers: first planner result `intake_failed`, second delivery deduplicated. Observed **statuses [200,200], two deliveries, one planner attempt**.
- Email already reads saved `ai_handled` on replay and returns 503 for failed planning; use its established pattern. Independently cover reply/escalation duplication on replay.
- Fix/retest: retry unhandled saved messages with original provider-ref idempotency; propagate retryable failures; cover `no_scope`, `intake_failed`, thrown errors, failed/missing handled-state reads, retry success, completed duplicates, cross-family scope and duplicate escalation.

### API-DISC-F03 — HIGH: HTTP 204 voicemail responses throw at runtime

- Source: `app/api/contact-center/voice/transcription/route.ts:32`, `:37`, `:78` all construct `new NextResponse('', { status: 204 })`.
- Actual installed NextResponse on Node 22.23.1 throws **TypeError: Response constructor: Invalid response status code 204** because HTTP 204 cannot carry even an empty-string body. Normal transcription crashes after side effects; empty/missing-family callbacks also crash.
- Reproduced while executing the real handler with mocked DB/provider dependencies. AST search across all 137 route files found this non-null-body/204 pattern only in these three branches.
- Fix/retest: use null body; execute normal, empty-transcript and missing-family branches with real NextResponse; assert 204/no body and no unnecessary side effects.

### API-DISC-F04 — MEDIUM: Social AI lacks the shared durable request guard

- Source-traced chain: `app/api/social/ai/route.ts` → `lib/social/access.ts` → `lib/social/ai.ts` → `lib/ai/observability.ts` → `provider.complete`.
- User authentication, `generate_ai` permission and bounded input exist, but this chain contains no request limiter/allowance check before paid model calls. `withAiRequest` records usage and deliberately does not deny work when bookkeeping fails.
- Successful generation and usage inserts also ignore returned Supabase errors, allowing missing history/usage behind a 200 response.
- This finding is **source-traced, not load/live-provider verified**. `tests/ai-route-rate-limit-contract.test.ts` omits `/api/social/ai` and recognizes only inline provider references, missing this delegated path.
- Next independent workflow: bounded per-user/family guard before generation; executable 429/Retry-After/provider-not-called tests and truthful persistence-failure handling.

## Critical workflow map

Every API/action/service file and export is individually enumerated in JSON. This map identifies the cross-cutting authority and verification targets.

| Workflow | Caller/entry and authority | Data/provider and remaining verification |
|---|---|---|
| Registration/login/OTP/OAuth/logout | `components/auth/{signup-form,login-form,phone-auth,oauth-buttons}.tsx`; `/auth/callback`, `/auth/signout`; Supabase SDK, safe redirects, durable session cookies/refresh transport | Auth provider + family/profile provisioning; browser expired/refresh/recovery/replayed-code, multiple-tab/device and redirect matrix |
| Child PIN login | `app/(auth)/actions.ts`, `family/child-login-actions.ts`; secret-derived password, username/IP durable throttles, manager controls | `child_logins`, `child_login_throttle`, Auth; parent→child lifecycle, concurrent lockout, disabled/deleted child and actual session role |
| Tenant context/roles | `lib/supabase/{auth,bearer}.ts`; verified user → active `family_members` → real `families` → membership-bounded preference; `ServiceScope` | Parent/adult/teen/child/caregiver/guest plus trusted system actors; distinct-role live read/write, cross-family IDs, disabled membership, partial-read outage |
| MFA/private export | `lib/auth/require-aal2.ts`, `/api/privacy/export`; manager assurance and scoped export; trust ledger before bytes | Supabase MFA, `trust_audit_logs`, export sections; enrollment/recovery, direct API/action bypass, role-specific export and ledger failure |
| Admin/marketing | `app/(app)/admin/**/actions.ts`, `/api/admin/**`; `isSuperAdmin`, `assertSuperAdmin`, `requireMarketingAdmin` before service-role client | Site/marketing settings, admin/audit tables and provider configuration; non-admin direct actions, role/account mutation, secrets and audit persistence |
| Ask Bubaly/run/approval | `/api/ai/requests`, run controls, concierge actions and inline `editStepAction`; cookie/bearer auth, limit/access gate, planner/store/executor; manager/request-owner controls, rerun/edit manager-only | Request/run/step/approval/trust/tool-operation ledgers; idempotency, malformed/refused model output, stale permissions, cross-family IDs, approve/cancel races, lease recovery |
| Specialist AI | `/api/ai/**`, recipes/vacations/behavior/social/paperwork and assistant tools; scoped context, domain checks, bounded/fenced input and guards on most paid routes | 135 AI/orchestration modules, provider models/structured output/usage; concrete output→persistence→UI, timeout/refusal, role context, missing-guard gaps |
| Scheduled/background | `/api/cron/**`, concierge-call dispatch; `hasCronAuthorization`, service role/system scopes, claims/leases/bounded time slices | Notification/AI/sync/marketing/wallet/auction jobs; scheduler invocation, partial failure, concurrency and duplicate ticks using test-only recipients/providers |
| Household CRUD | 49 service modules, 124 action modules and assistant tools; actor role/family scope, result contracts and explicit family filters | Family/tasks/calendar/finance/food/files/trips/memory/messages/home/moving/inventory/notes/goals/school/sports; full CRUD by role, foreign IDs, concurrency, persistence/UI |
| Billing/wallet/marketplace | `/api/billing/**`, Stripe/money webhooks, wallet/money/economy/marketplace actions; parent-only billing, verified prices, limits, signatures, atomic operations | Stripe, billing/subscription/card/wallet/auction records; sandbox checkout/change/cancel→entitlement, replay/partial write, ledger consistency |
| Calendar/provider sync | `/api/{google/calendar,sync}/**`, onboarding calendar actions; OAuth state, family/account ownership, unguessable feed token | OAuth adapters/tokens/calendar/sync maps; connect→callback→preview→import→sync→disconnect, state replay, CSRF, revoked credentials |
| Files/paperwork/import | Paperwork/travel confirmation APIs and document/paperwork/trip services; role/scope, file/URL safety, byte bounds and signed storage | Storage/document/paperwork/inbox/OCR/AI; real upload/download/delete, MIME/size/filename, URL redirects, expiry and attachment retry |
| Public marketing/guardian/notifications | Contact/forms/blog/telemetry/LP endpoints, Resend/Twilio callbacks, push routes; limits/signatures/tokens/consent/user subscriptions | CRM/telemetry/queues + email/push/SMS; anonymous abuse, consent, duplicate delivery, unsubscribe preferences, recipient correctness and retry→UI |

Unexecuted workflows remain unverified; they are not BLOCKED just because they need testing. Live RLS/auth and provider delivery need the designated database/accounts and sandbox/provider credentials. Track those external portions separately from repository defects.

## Executed tests and reproductions

Executed:

`node node_modules/vitest/vitest.mjs run tests/middleware-public-api-boundary.test.ts tests/middleware-bearer-api.test.ts tests/middleware-oauth-code-routing.test.ts tests/auth-context-integrity.test.ts tests/admin-authz-gate.test.ts tests/contact-center-routing-to-planner.test.ts tests/ai-route-rate-limit-contract.test.ts`

Result: **7 files / 48 tests passed**, 2.34 seconds. These do not negate the failing reproductions: middleware tests check strings and omit Contact Center; routing tests use an in-memory helper flow instead of the HTTP middleware/acknowledgement chain. Root separately reported the full baseline suite passing 1,121 files / 12,418 tests; that is not live workflow verification.

Reproduce F01 from repository root in PowerShell (dummy config; no network):

```powershell
@'
const fs=require('fs'),ts=require('typescript'),vm=require('vm');
const {NextRequest,NextResponse}=require('next/server');
function local(file,custom={}) {
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exp={};
  vm.runInNewContext(code,{exports:exp,require:s=>{if(Object.hasOwn(custom,s))return custom[s];throw Error(s);},process:{env:{NEXT_PUBLIC_SUPABASE_URL:'https://test-project.supabase.co',NEXT_PUBLIC_SUPABASE_ANON_KEY:'test-public-key'}},URL,console});
  return exp;
}
const {middleware}=local('middleware.ts',{
  'next/server':{NextRequest,NextResponse},
  '@supabase/ssr':{createServerClient:()=>({auth:{getUser:async()=>({data:{user:null},error:null})}})},
  '@/shared/auth/refresh-fetch':{createSessionRefreshFetch:()=>fetch},
  '@/lib/auth/redirect':local('lib/auth/redirect.ts'),
  '@/lib/auth/session':local('lib/auth/session.ts')
});
(async()=>{for(const p of ['/api/contact-center/email','/api/contact-center/sms','/api/contact-center/voice','/api/contact-center/voice/transcription?familyId=test','/api/contact','/api/guardian/inbound/sms','/api/webhooks/stripe']) {
  const r=await middleware(new NextRequest('https://audit.invalid'+p,{method:'POST',headers:{'x-inbound-secret':'test-secret','x-twilio-signature':'test-signature'}}));
  console.log(JSON.stringify({path:p,status:r.status,location:r.headers.get('location'),next:r.headers.get('x-middleware-next')}));
}})();
'@ | node
```

Minimal installed-framework F03 reproduction:

```powershell
node -e "const {NextResponse}=require('next/server'); new NextResponse('', {status:204});"
```

F02 used the same TypeScript/VM pattern for the actual SMS route export, with: verified signature; bounded form with To/From/Body/MessageSid; a test family/channel with concierge disabled and no escalation phone; `recordInboundMessage` returning inserted=true then false with unchanged messageId/providerRef; and `routeInboundToPlanner` returning `{reason:'intake_failed'}` and counting calls. Two actual POST invocations produced `{deliveryStatuses:[200,200],plannerAttempts:1,deliveries:2}`. Subsequent voicemail invocation threw the real F03 error. Regression tests should execute those actual exports and failure/replay boundaries.

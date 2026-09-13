# Claude-3 — Backend / API / Database / Auth / Security

Findings only. Format:

```
[CLAUDE-3][SEVERITY][AREA] Title
File:     path/to/file.ts:line
Problem:  what is wrong
Evidence: what proves it (command output, code, a live response)
Impact:   who is hurt and how
Fix:      recommended change
Status:   OPEN | VERIFIED | FIXED | BLOCKED
```

SEVERITY: CRITICAL | HIGH | MEDIUM | LOW

---

## Method

Not a re-derivation of `finalaudit.md`. Two things the prior passes did not do:

1. **The 308 migrations were actually replayed** into a local Postgres 16
   (`/var/tmp/pgaudit`, port 5599) behind a Supabase-shaped prelude (`anon`,
   `authenticated`, `service_role`, `auth.uid()`, `storage.*`). 482 public
   tables were created; only three migrations failed, all for reasons local to
   the harness (`vector` extension absent → `0237`, and its two dependants).
   Every RLS/grant/policy/function statement below is a query against that live
   schema, not a grep of SQL text. This matters: the repo enables RLS through
   `DO $$ ... EXECUTE format('alter table public.%I enable row level security')`
   loops, so a text scan reports 216 false "missing RLS" tables and the live
   catalogue reports **zero**.
2. **Every one of the 141 `app/api/**/route.ts` handlers was mapped to the
   authorization call it makes**, and the 61 routes carved out of the session
   boundary by `lib/auth/route-access.ts` PUBLIC were each read.

The API and RLS surface came back clean (see "Verified healthy"). The findings
are concentrated where authorization is expressed in **two places that
disagree**: a server-side page guard and an RLS policy that does not encode the
same rule — and the browser talks to PostgREST directly, so the policy is the
only one that binds.

---

## Findings

```
[CLAUDE-3][CRITICAL][DATABASE/AUTHZ] Every child can read, edit and delete the family password vault
File:     supabase/migrations/0119_family_credentials.sql:42-60 (family_credentials_* policies)
          app/(app)/dashboard/passwords/page.tsx:8-11
          components/modules/passwords-module.tsx:116-144
          lib/auth/mfa.ts:102-105
Problem:  public.family_credentials — the Wi-Fi / logins / PINs / card vault — is
          governed by four policies that all use is_family_member(family_id):

            family_credentials_select | SELECT | roles=public | qual=is_family_member(family_id)
            family_credentials_insert | INSERT | roles=public | check=~
            family_credentials_update | UPDATE | roles=public | qual=is_family_member(family_id)
            family_credentials_delete | DELETE | roles=public | qual=is_family_member(family_id)

          is_family_member() does not look at role:

            select exists (select 1 from public.family_members
              where family_id = p_family_id and user_id = auth.uid() and is_active);

          whereas can_manage_family() does (`role in ('parent','adult')`). Child
          members are real auth users with family_members.user_id set —
          app/(app)/family/child-login-actions.ts:49-60 creates the auth user and
          then `update({ user_id: childUserId, is_active: true })`. So a signed-in
          child passes is_family_member and the vault is fully open to them.

          The two guards that look like they stop this do not:
          - The page has no role check at all, only requireUserContext +
            requireAal2 (passwords/page.tsx:9-10).
          - requireAal2 is a no-op for children: needsStepUp() is
            `const manager = role === 'parent' || role === 'adult'; return manager && ...`
            (lib/auth/mfa.ts:103-104) — a child never needs step-up.
          - And neither guard is load-bearing anyway: passwords-module.tsx is
            'use client' and reaches family_credentials through createClient()
            (the browser Supabase client), so RLS is the only boundary.

          The column is plaintext: `secret:text`, no encryption on the write path
          (passwords-module.tsx:118 `secret: form.secret`).
Evidence: psql against the replayed schema:
            $ select policyname,cmd,qual from pg_policies
                where schemaname='public' and tablename='family_credentials';
            family_credentials_select | SELECT | is_family_member(family_id)
            ... (all four as quoted above)
            $ select column_name||':'||data_type from information_schema.columns
                where table_name='family_credentials';
            ... secret:text ...
          Contrast, same query on `documents`, which DOES encode the rule:
            documents_select | SELECT | (is_family_member(family_id) AND
              ((NOT is_sensitive_document(is_secure, category)) OR can_manage_family(family_id)))
Impact:   Any child with a username+PIN login can read every stored family
          secret in plaintext — Wi-Fi passwords, account logins, door PINs, card
          details — by opening /dashboard/passwords, or by issuing one PostgREST
          request with the public anon key. They can also silently DELETE the
          whole vault (the module's "delete" is a soft delete, but the policy
          permits a hard DELETE too). This is the single worst authorization gap
          I found.
Fix:      Mirror the `documents` pattern. Replace all four policies with
          can_manage_family(family_id) — there is no product reason a child
          writes to the credential vault:
            drop policy family_credentials_select on public.family_credentials;
            create policy family_credentials_select on public.family_credentials
              for select using (can_manage_family(family_id));
          (same for insert/update/delete). Then add the role check to
          app/(app)/dashboard/passwords/page.tsx so a child gets an honest page
          rather than an empty one, and open a separate item for encrypting
          `secret` at rest (the vault stores it in the clear today, so a
          service-role read or a DB dump is a full compromise).
Status:   VERIFIED (policies + helper functions read from the replayed schema;
          child membership path read in source). Not exploited against a live
          deployment — no credentials.
```

```
[CLAUDE-3][HIGH][AUTH] Step-up MFA is a page redirect only; no RLS policy knows about `aal`
File:     lib/auth/require-aal2.ts:76-79
          app/(app)/dashboard/bills/page.tsx:7, expenses/page.tsx:10, autopay/page.tsx:6,
          family-cfo/page.tsx:39, files/vault/page.tsx:14, files/shared/page.tsx:14,
          files/cloud/page.tsx:14, passwords/page.tsx:10, paperwork/page.tsx:19 (19 pages total)
          components/finance/bills-view.tsx:54,58,63,156
Problem:  requireAal2() protects 19 server-rendered pages by calling
          `redirect(stepUpPath)`. The data those pages show is not fetched by
          those pages. It is fetched by client components straight from
          PostgREST with the browser's own session:

            components/finance/bills-view.tsx:54
              const { error } = await createClient().from('bills').update({ status: next }).eq('id', b.id);
            components/finance/bills-view.tsx:63
              const { error } = await createClient().from('bills').delete().eq('id', id);
            components/modules/passwords-module.tsx:116
              const sb = createClient();

          An aal1 session (password only, no second factor) is a fully valid
          Supabase JWT. The redirect is the only thing that stops it, and the
          redirect only happens if the browser asks the Next.js server for the
          HTML page — which an attacker holding a stolen session cookie has no
          reason to do.

          The guard's own docstring anticipates the API half ("Route handlers
          use this to answer `403 step_up_required` where a page would
          redirect", require-aal2.ts:61-63) and `aal2Verdict` exists for it —
          but it is wired into exactly three routes (paperwork/capture,
          paperwork/link, privacy/export). Nothing in the `money` area uses it,
          and no route or policy enforces it on the direct-to-PostgREST path at
          all.
Evidence: $ grep -rn "aal2Verdict" app lib components
            app/api/paperwork/link/route.ts:21
            app/api/paperwork/capture/route.ts:19
            app/api/privacy/export/route.ts:46
            (+ its own definition and tests — nothing else)
          Against the replayed schema:
            $ select count(*) from pg_policies where schemaname='public'
                and (coalesce(qual,'')||coalesce(with_check,'')) ilike '%aal%';
            0
          And the policies on the tables the gated pages show:
            bills_select | SELECT | is_family_member(family_id)
            bills_update | UPDATE | can_manage_family(family_id)
          — role-aware, assurance-blind.
Impact:   Step-up MFA is presentational. Someone with a stolen or exported
          session cookie for a parent account — the precise threat a second
          factor is bought to answer — reads and writes bills, expenses,
          autopay, the document vault and the credential vault without ever
          being asked for a code. The families most likely to enrol a factor are
          the ones who believe it is protecting exactly this data.
Fix:      Two layers, both needed:
          (a) Enforce in the database, which is where the browser actually
              lands. Add a helper reading the JWT claim —
                create function public.session_is_aal2() returns boolean
                  language sql stable as $$
                    select coalesce(auth.jwt()->>'aal','aal1') = 'aal2' $$;
              — and AND it into the policies on the money/document tables for
              members whose account has a verified factor.
          (b) Have every route handler and server action behind a gated page
              call aal2Verdict() and answer 403 step_up_required, the way
              privacy/export already does (app/api/privacy/export/route.ts:46-48),
              so non-browser callers get the same answer.
          Until (a) exists, requireAal2 should not be described as protecting
          money or documents.
Status:   VERIFIED (grep + live catalogue query; the client-side write path read
          in source).
```

```
[CLAUDE-3][HIGH][STORAGE] The `family-media` bucket is public, so family photos and message attachments are served to anyone with the URL
File:     supabase/migrations/0216_family_media_bucket.sql:22-30
          components/modules/photos-module.tsx:116-123
          components/modules/inventory-module.tsx:37,355; components/modules/closet-module.tsx:43,415
Problem:  The bucket is created with `public = true`:
            insert into storage.buckets (id, name, public, file_size_limit)
            values ('family-media', 'family-media', true, 26214400)
          A public Supabase bucket is served at
          /storage/v1/object/public/family-media/<path> with no session and no
          RLS evaluation. The four family-scoped policies the same migration
          creates ("Family members can read their media", etc.) only govern the
          authenticated /object/ path, so they do not restrict delivery. The
          migration says so itself (lines 10-14, 26-30) and calls hardening a
          tracked follow-up (LB-009) — but the exposure is live now.

          Four features write here: Photos, Create-Memory, message attachments
          and reminder attachments (migration header, lines 4-5), and the stored
          rows keep the public URL (photos-module.tsx:123 `getPublicUrl`).
Evidence: $ select id||' public='||public from storage.buckets;   -- replayed schema
            documents public=false
            chore-proof public=false
            marketing-assets public=false
            avatars public=true
            marketplace-photos public=true
            feedback-attachments public=true
            family-media public=true
          The private `documents` bucket is the control: same family-folder path
          convention, `public=false`.
Impact:   Every family photo, video, private message attachment and reminder
          attachment is readable by anyone who ever obtains the URL, forever —
          past the point where the uploader deletes the row, leaves the family,
          or has their membership revoked, because revocation happens in
          family_members and the public path never consults it. URLs leak the
          ordinary ways: Referer headers, a link pasted anywhere, a CDN or proxy
          log, a scraped page. Paths are UUID-based so they are not enumerable —
          that is the only thing limiting this, and it is not an access control.
Fix:      Flip the bucket to `public=false` and serve through
          `createSignedUrl()` with a short TTL; the existing SELECT policy then
          becomes load-bearing rather than decorative. It needs the data
          migration of stored URLs that the migration comment names (rewrite
          family_photos / family_messages URL columns to store the storage path
          and resolve at render time), which is why this is a real piece of work
          and not a one-line flag flip — but it should be scheduled, not left as
          a comment.
Status:   VERIFIED (bucket flags read from the replayed schema; the decision is
          documented in-migration, the exposure is not disputed).
```

```
[CLAUDE-3][MEDIUM][DATABASE/AUTHZ] OAuth tokens in `social_account_tokens` are family-member readable; the equivalent `sync_tokens` is service-only
File:     supabase/migrations/0034_social_command_center.sql (social_account_tokens policies)
          supabase/migrations/0018_sync_platform.sql:663 (sync_tokens — the correct pattern)
Problem:  Two tables hold third-party OAuth credentials in identically named
          columns (access_token_enc, refresh_token_enc, scope, expires_at). They
          are protected completely differently:

            sync_tokens            | tokens service only          | ALL    | qual=false  | check=false
            social_account_tokens  | social_account_tokens_select | SELECT | qual=is_family_member(family_id)
            social_account_tokens  | social_account_tokens_insert | INSERT | check=is_family_member(family_id)
            social_account_tokens  | social_account_tokens_update | UPDATE | qual=is_family_member(family_id)
            social_account_tokens  | social_account_tokens_delete | DELETE | qual=is_family_member(family_id)

          `qual=false` is the right answer for a token table: no client role
          reads it, only the service role (which bypasses RLS). The social table
          allows any active family member — including a child — to SELECT the
          stored tokens and to UPDATE them with values of their choosing.
Evidence: $ select policyname,cmd,qual,with_check from pg_policies
              where schemaname='public' and tablename in ('sync_tokens','social_account_tokens');
          (output as quoted above, from the replayed schema)
Impact:   Latent rather than live: no application code reads or writes
          social_account_tokens today — the only references are
          lib/ai/context/policy.ts:39 (which denylists it from AI context,
          reason 'OAuth tokens') and lib/database.types.ts. So the table is
          empty in practice. The moment the Social Command Center is connected
          to a real provider, a child in the household can exfiltrate the
          parent's social access and refresh tokens with one anon-key request,
          or overwrite them to point at an account they control.
Fix:      Bring it to the sync_tokens standard before the feature ships:
            drop policy social_account_tokens_select on public.social_account_tokens;
            ... (all four)
            create policy "social tokens service only" on public.social_account_tokens
              for all using (false) with check (false);
          If a family-facing read is ever needed, expose connection *status*
          from social_accounts, never the token columns.
Status:   VERIFIED (policies read from the replayed schema; "unused today"
          confirmed by grep across app/, lib/, components/).
```

```
[CLAUDE-3][MEDIUM][STORAGE] `feedback-attachments` is a public bucket holding user-uploaded screenshots
File:     supabase/migrations/0197_feedback_ideas.sql:163,173
Problem:  The bucket is `public=true` and additionally carries an explicit
          `for select using (bucket_id = 'feedback-attachments')` policy (line 173)
          with no owner condition — so it is world-readable by both the public path and
          the authenticated path. Writes are correctly scoped
          (line 178: `auth.uid()::text = (storage.foldername(name))[1]`); reads are
          not scoped at all.
Evidence: $ select id||' public='||public from storage.buckets;
            feedback-attachments public=true
          $ select policyname,cmd,qual from pg_policies where schemaname='storage';
            objects | Feedback attachments are publicly readable | SELECT | (bucket_id = 'feedback-attachments'::text)
Impact:   Feedback attachments are, by their nature, screenshots of the app
          taken at the moment something went wrong — which is to say screenshots
          of a real family's calendar, children's names, balances or documents.
          Anyone with the URL, and anyone who can list the bucket, reads them.
          Lower than family-media only because the volume is small and the
          upload is deliberate.
Fix:      Make the bucket private and drop the blanket SELECT policy; replace it
          with `auth.uid()::text = storage.foldername(name)[1] OR is_super_admin()`
          so the reporter and the admin triaging the report can see it and
          nobody else. Admin console reads already go through the service role,
          so they are unaffected.
Status:   VERIFIED (bucket flag + policy read from the replayed schema).
```

```
[CLAUDE-3][MEDIUM][SECRETS] The Contact Center inbound-email secret is accepted in the query string
File:     app/api/contact-center/email/route.ts:33-38
Problem:  function authorized(req: NextRequest): boolean {
            const secret = process.env.CONTACT_CENTER_INBOUND_SECRET;
            if (!secret) return process.env.NODE_ENV !== 'production';
            const provided = new URL(req.url).searchParams.get('key') ?? req.headers.get('x-inbound-secret');
            return !!provided && provided === secret;
          }
          The fail-closed half is right (an unset secret disables the route in
          production, exactly as lib/auth/route-access.ts:104-106 claims). The
          problem is `?key=<secret>`: a long-lived shared secret travelling in a
          URL is written verbatim into platform access logs, any proxy or WAF in
          front of the deployment, and error-tracking breadcrumbs, and is the
          one part of a request most likely to be pasted into a ticket.
Evidence: The code above; the header alternative already exists on the next line,
          so the query-string branch is a convenience, not a requirement.
Impact:   Whoever can read the deployment's HTTP logs can replay inbound email
          into any family's Contact Center — injecting messages that appear to
          come from outside. Rotation is the only remedy once it has leaked, and
          nothing will signal that it has.
Fix:      Drop the searchParams branch; require `x-inbound-secret`. If the email
          provider cannot send a custom header, put an unguessable random
          segment in the *path* and treat that as the capability (the pattern
          /api/sync/feeds/[token] already uses), so at least it is per-route and
          rotatable without touching every other caller.
Status:   OPEN — confirmed in source. Whether the configured provider can send a
          header is an operator question; that answer decides which fix applies.
```

```
[CLAUDE-3][MEDIUM][AUTH] Twilio signature verification is switched off outside production, and depends on NEXT_PUBLIC_APP_URL being exactly right
File:     app/api/guardian/inbound/sms/route.ts:27-33 (and voice:34, whatsapp:35,
          screen:39, status/voicemail:32, escalate/twiml:17-22,
          app/api/contact-center/{voice,sms,voice/transcription}/route.ts)
Problem:  All nine Twilio-facing webhooks share one shape:
            if (process.env.NODE_ENV === 'production') {
              const sig = req.headers.get('x-twilio-signature') ?? '';
              const url = `${BASE_URL}/api/guardian/inbound/sms`;
              if (!validateTwilioSignature(sig, url, params)) return new NextResponse('Unauthorized', { status: 401 });
            }
          Two consequences.
          (a) Outside production the check is skipped entirely — there is no
              signature check at all in any preview, staging or self-hosted
              deployment that does not set NODE_ENV=production. These routes are
              on the PUBLIC list, so they are reachable with no session, and
              they write to guardian tables and fan out SMS/voice.
          (b) `BASE_URL` is `process.env.NEXT_PUBLIC_APP_URL ?? ''`. Twilio signs
              the exact URL it called. If NEXT_PUBLIC_APP_URL is unset, has a
              trailing slash, or differs from the public hostname Twilio was
              configured with, every signature mismatches and every callback
              401s — Guardian and the Contact Center go silently dead with a
              "provider problem" shape, which is exactly the failure mode
              lib/auth/route-access.ts:95-106 was written about.
          The HMAC itself is correct (sha1 over url + sorted params,
          timingSafeEqual, returns false when TWILIO_AUTH_TOKEN is unset —
          lib/guardian/twilio.ts:130-146).
Evidence: The nine call sites, identical; lib/guardian/twilio.ts:134
          `if (!TWILIO_AUTH_TOKEN) return false;`
Impact:   (a) is a security gap in every non-production deployment: unauthenticated
          POSTs can forge inbound calls/messages and trigger scam-detection,
          notifications and outbound SMS. (b) is an availability trap that
          fails closed, so it is safe but invisible.
Fix:      (a) Invert the condition: verify whenever TWILIO_AUTH_TOKEN is set,
              and skip only when it is absent (which is the honest definition of
              "Twilio is not configured here"). That keeps local development
              working without leaving preview deployments open.
          (b) Derive the signed URL from the request the platform actually
              received (x-forwarded-proto + x-forwarded-host, falling back to
              NEXT_PUBLIC_APP_URL) and log a distinguishable reason on mismatch,
              so a misconfigured hostname says so instead of looking like a bad
              signature.
Status:   OPEN — confirmed in source at all nine call sites. Which deployments
          run with NODE_ENV != 'production' is an operator question.
```

```
[CLAUDE-3][LOW][AUTH] Shared-secret comparisons are not constant time
File:     lib/server/cron-auth.ts:5-11
          app/api/guardian/escalate/route.ts:24-28
          app/api/contact-center/email/route.ts:37
Problem:  export function hasCronAuthorization(req: Request, secret = process.env.CRON_SECRET): boolean {
            return !!secret && req.headers.get('authorization') === `Bearer ${secret}`;
          }
          `===` on strings short-circuits at the first differing byte. The same
          applies to the guardian escalate check (`authHeader !== \`Bearer ${secret}\``)
          and the contact-center `provided === secret`. The Twilio path already
          does this correctly with crypto.timingSafeEqual
          (lib/guardian/twilio.ts:143).
Problem2: Noted, not alarmed about: extracting a secret through remote timing
          over HTTP against a serverless platform is not a practical attack.
          This is a consistency finding — the codebase already owns the right
          primitive and uses it three files away.
Evidence: The three call sites above; lib/guardian/twilio.ts:143 as the
          in-repo counter-example.
Impact:   Theoretical. Recorded so it is a deliberate decision rather than an
          oversight, since these three secrets gate every cron job, the
          emergency escalation fan-out, and inbound email respectively.
Fix:      One helper, used by all three:
            import { timingSafeEqual } from 'crypto';
            export function secretMatches(provided: string | null, expected: string | undefined): boolean {
              if (!provided || !expected) return false;
              const a = Buffer.from(provided), b = Buffer.from(expected);
              return a.length === b.length && timingSafeEqual(a, b);
            }
          The fail-closed-on-missing-secret behaviour must be preserved exactly;
          it is the more important property and it is already correct.
Status:   OPEN
```

```
[CLAUDE-3][LOW][API] An authorization failure in the marketing AI route answers 500, not 403
File:     app/api/admin/marketing/ai/route.ts:87-91
Problem:  } catch (err) {
            console.error('Marketing AI error:', err);
            const msg = err instanceof Error && err.message.includes('Forbidden') ? 'Forbidden' : 'Could not generate. Check that the OpenAI API key is set.';
            return NextResponse.json({ error: msg }, { status: 500 });
          }
          requireMarketingAdmin() throws to refuse. The catch recognises the
          refusal well enough to change the message but still answers 500 —
          and requireMarketingAdmin's messages are the 'sign in' / 'permission'
          strings the sibling route matches on
          (app/api/admin/marketing/email/send/route.ts:48), not 'Forbidden', so
          in practice a non-admin caller is told "Check that the OpenAI API key
          is set" with a 500.
Evidence: The two routes side by side; send/route.ts:48-52 gets it right
          (403 for forbidden, 502 for provider, 400 otherwise).
Impact:   No access is granted — the request is refused either way. The cost is
          operational: a permissions problem is indistinguishable from an outage
          in logs and alerting, and it points the operator at the wrong
          subsystem.
Fix:      Match the sibling: detect the refusal on the same
          'sign in' | 'permission' | 'Forbidden' predicate and answer 403,
          leaving 500 for genuine faults. Better, give requireMarketingAdmin a
          typed error so neither route has to match on message text.
Status:   OPEN
```

---

## Verified healthy — do not re-spend effort here

Recorded because each of these was a live hypothesis on my brief and each is now
closed by a query against the replayed schema or an exhaustive read, not a
sample. If a later pass wants to re-open one, the command is given.

1. **RLS coverage is total.** All 482 tables in `public` have
   `relrowsecurity = true`.
   `select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and relkind='r' and not relrowsecurity;`
   → **empty**. A text scan of the migrations suggests 216 tables are missing
   RLS; that is an artefact of the `DO $$ ... EXECUTE format(...)` loops the repo
   uses (0004, 0006, 0009, 0022, 0034, 0037, 0070, 0088, 00901, …) and is wrong.

2. **No `using (true)` on any family-scoped table.** Across every permissive
   policy granted to `anon` / `authenticated` / `public`, exactly four have a
   literally-true expression, and all four are global reference data:
   `badges`, `feature_flags`, `meal_ideas`, `service_descriptions` — all
   SELECT-only.

3. **`anon` holds no write privilege on any table at all** (not just the five
   money tables of F-003): the `role_table_grants` query for
   INSERT/UPDATE/DELETE/TRUNCATE to `anon` returns zero rows across all 482.

4. **Every `app/api` route authorizes itself.** All 141 handlers were mapped to
   their guard. The 61 routes carved out of the session boundary by
   `route-access.ts` PUBLIC each carry their own: 23 cron routes +
   /api/concierge-calls/place on `hasCronAuthorization` (fail-closed —
   `!!secret && ...`), 9 Twilio routes on signature (but see the MEDIUM above),
   3 webhook routes on provider signatures, /api/email/welcome on
   `hasInternalSecret`, the token-capability routes (/api/sync/feeds/[token],
   /api/assistant, /api/ai/gift, /api/blog/unsubscribe,
   /api/marketing/unsubscribe) on the token itself plus a rate limit, and every
   public telemetry/form endpoint on `enforceRequestRateLimit` +
   `readBoundedRequestJson`. The two `app/api/admin/*` routes that showed no
   guard in a first grep both call `requireMarketingAdmin`; the third,
   `admin/benchmarks/export`, re-checks `isSuperAdmin()` in the handler
   precisely because a route handler is not covered by the /admin layout
   (benchmarks/export/route.ts:19-20).

5. **No unbounded request-body parsing anywhere.**
   `grep -rn "await req.json()" app lib` → **0 hits**. Every handler that reads a
   body goes through `readBoundedRequestJson` / `readBoundedRequestText` /
   `readBoundedRequestFormData` with an explicit byte cap.

6. **No secrets in client-reachable config.** The complete set of
   `NEXT_PUBLIC_*` in use is APP_URL, BUILD_ID, SITE_URL,
   STRIPE_PUBLISHABLE_KEY, SUPABASE_ANON_KEY, SUPABASE_URL, VAPID_PUBLIC_KEY,
   VERCEL_GIT_COMMIT_SHA — all eight are publishable by design. No `.env` file
   is committed (only `.env.example`).

7. **No secrets or PII in logs.** The `console.*` sweep for token/secret/
   password/pin/key/jwt/session/email surfaced six hits, all benign: two log an
   internal session id, one logs a lead email inside a cron failure path
   (app/api/cron/journey-recovery/route.ts:94 — arguably worth trimming), and
   the rest are subject lines in the "email skipped, no API key" dev notice.

8. **No SQL injection surface.** Every `EXECUTE format(...)` in the migrations
   uses `%I` / `%1$I` identifier quoting over a literal `array[...]` of table
   names — never a value from a request. No string-interpolated SQL in
   application code.

9. **No SSRF.** The only raw `fetch()` with a computed URL on the server
   (app/api/weekend/discover/route.ts:20) is called with two hard-coded provider
   hosts and a `isValidZip`-validated query. Every user-supplied URL —
   library feeds, calendar feeds, documents, media — goes through the guarded
   `lib/server/{external,public-calendar,public-document,public-media}-fetch.ts`
   helpers, which carry the blocked-subnet list, DNS pinning and a redirect
   budget.

10. **`SECURITY DEFINER` functions are sound.** All 64 were dumped and their
    EXECUTE grants resolved. Every one callable by `anon` is either a trigger
    function (not invocable through PostgREST) or a predicate helper; every
    state-changing RPC re-derives the caller's identity internally
    (`is_family_member`, `marketplace_member_id`, `auth.uid()`) and raises
    rather than trusting an argument — e.g. `grocery_from_meal_plan` opens with
    `if not public.is_family_member(p_family_id) then raise exception`, and
    `marketplace_accept_offer` with `if v_caller is null or v_listing.member_id
    is distinct from v_caller then raise exception`.

11. **Tables with RLS on and zero policies are deliberate, not broken.** 57 such
    tables exist (marketing_*, mkt_*, stripe_webhook_events, super_admins,
    rate_limits, survey_responses, …). Each was spot-checked for an application
    read path: all are reached only through `createServiceClient()`. "No policy"
    is the service-only idiom here, same as `sync_tokens`' explicit
    `using (false)`.

12. **Server actions are guarded.** Of 132 files containing `'use server'`, 8
    make no auth call; 5 of those are not action files at all (the string
    appears in a comment), and the 3 real ones are the deliberately
    unauthenticated public flows — gift pledge, public review submission, public
    survey response — each of which uses the service client behind an
    unguessable token plus `enforceRequestRateLimit` (app/gift/actions.ts:30-45
    additionally caps pending pledges per link at 25).

---

## What I could not reach

- **Production.** Every schema statement above is from the local replay of the
  committed migrations. `finalaudit.md` F-001 says the production ledger records
  only `0001–0003`, which — if still true — means the production database does
  not have most of the policies I verified, including the ones I am calling
  correct. Nothing here should be read as a statement about production until
  F-001 is unblocked. This cuts both ways: the CRITICAL above may be *worse* in
  production, not better.
- **Migrations 0237, 0239, 0292** did not replay (the `vector` extension is not
  installed locally), so the `marketing_generation_jobs` /
  `marketing_page_embeddings` tables from the marketing platform spine are
  absent from my schema and were not checked for RLS or policies. Everything
  else replayed.
- **No live requests were made.** No credentials, and the brief is audit-only. A
  one-line curl with a child's anon-key JWT against
  `/rest/v1/family_credentials?select=*` would settle the CRITICAL finding
  empirically in production; I did not have a session to do it with.

# Runbook — taking Google (and Microsoft) OAuth to production

Every OAuth failure this app has shipped was a **configuration** failure that the
provider reported as an unnamed 400. This runbook is the configuration, in one
place, plus the one command that checks it before a deploy.

```bash
npm run verify:oauth
```

It reads the environment (`.env`, `.env.local`, or whatever the shell exports),
prints no secrets, and exits non-zero on anything a provider would reject. Run it
against production values before pasting them into Vercel, not after the consent
screen turns red.

---

## 1. The two OAuth clients

Google Cloud Console → **APIs & Services → Credentials**. Both live in the same
Google Cloud project, which matters: **publishing status and verification are
per-project, not per-client.**

| Console client name | Used by | Env pair |
|---|---|---|
| **Bubaly** | Supabase sign-in with Google, and the read-only calendar import (`/api/google/calendar/*`) | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` |
| **Bubaly Calendar Synch** | Two-way calendar + tasks sync (`/api/sync/google/*`) | `GOOGLE_SYNC_CLIENT_ID` / `GOOGLE_SYNC_CLIENT_SECRET` |

If the `GOOGLE_SYNC_*` pair is unset, two-way sync **falls back** to the
`GOOGLE_*` pair (see `lib/sync/providers/google.ts`). That is a supported
single-client setup — but then every redirect URI below has to be registered on
that one client. `npm run verify:oauth` says which case you are in.

### Redirect URIs to register

Authorized redirect URIs are compared **byte-exact**. A trailing slash, `http`
instead of `https`, or a different host is `Error 400: redirect_uri_mismatch`.

On **Bubaly**:

```
https://www.bubaly.com/api/google/calendar/callback
https://ltcxlbipiihclxwioyqj.supabase.co/auth/v1/callback
```

On **Bubaly Calendar Synch**:

```
https://www.bubaly.com/api/sync/google/callback
```

The Supabase URL is not ours — it is where Supabase's hosted Google provider
receives the code before redirecting back to the app. It belongs on the sign-in
client only.

**Preview deployments.** When `GOOGLE_CALENDAR_REDIRECT_URI` /
`GOOGLE_SYNC_REDIRECT_URI` are unset, the callback URL is derived from the
request origin — which is a different `*.vercel.app` host for every preview, and
none of them are registered. Either set the variables explicitly per environment
or accept that OAuth only works on the registered hosts.

---

## 2. The consent screen — the setting that gates everything

Google Cloud Console → **APIs & Services → OAuth consent screen** (newer console:
**Google Auth Platform → Audience**).

**Publishing status must be `In production`.** While it is `Testing`:

- Only accounts on the **Test users** list can consent. Everyone else gets
  **`Error 403: access_denied`** — *"Bubaly has not completed the Google
  verification process"* — no matter how correct the client, the scopes, and the
  redirect URIs are. This is a per-project setting, so **editing redirect URIs
  will never clear it.**
- **Refresh tokens expire after 7 days.** Every connected calendar silently
  disconnects weekly. (The app handles this correctly since the reconnect
  work — a dead grant now clears the stored token and asks the user to
  reconnect rather than failing opaquely — but the right fix is not to be in
  Testing.)

Press **Publish app**. That alone removes the tester list and the 7-day expiry.

### Verification

The app requests `calendar.readonly`, `calendar.events` and `tasks`. Those are
**sensitive scopes**, so a published-but-unverified app still shows an
*"Google hasn't verified this app"* interstitial and is capped at 100 users.
Verification (submitted from the same consent screen) removes both. It requires
a verified domain, a privacy policy URL, a terms URL, and a demo video, and
Google's review takes days to weeks.

Publishing is immediate and is what unblocks real users; verification runs behind
it. Do not wait for verification to publish.

---

## 3. Environment variables

Set these in **Vercel → Project → Settings → Environment Variables → Production**
(and Preview, if OAuth should work there). Values come from the console; none of
them belong in the repository.

| Variable | Source | Required |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | `https://www.bubaly.com` | yes |
| `GOOGLE_CLIENT_ID` | Bubaly → Client ID | yes |
| `GOOGLE_CLIENT_SECRET` | Bubaly → Client secret | yes |
| `GOOGLE_CALENDAR_REDIRECT_URI` | `https://www.bubaly.com/api/google/calendar/callback` | optional, recommended |
| `GOOGLE_SYNC_CLIENT_ID` | Bubaly Calendar Synch → Client ID | optional (falls back) |
| `GOOGLE_SYNC_CLIENT_SECRET` | Bubaly Calendar Synch → Client secret | optional (falls back) |
| `GOOGLE_SYNC_REDIRECT_URI` | `https://www.bubaly.com/api/sync/google/callback` | optional, recommended |
| `GOOGLE_SYNC_CALENDAR_SCOPES` | `https://www.googleapis.com/auth/calendar.events` | optional |
| `GOOGLE_SYNC_CALENDAR_READONLY_SCOPE` | `https://www.googleapis.com/auth/calendar.readonly` | optional |
| `GOOGLE_SYNC_TASKS_SCOPES` | `https://www.googleapis.com/auth/tasks` | optional |
| `SYNC_TOKEN_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | **yes, for any sync** |
| `MICROSOFT_SYNC_CLIENT_ID` | Entra → App registrations → Application (client) ID | for Outlook sync |
| `MICROSOFT_SYNC_CLIENT_SECRET` | Entra → Certificates & secrets | for Outlook sync |
| `MICROSOFT_SYNC_TENANT` | `common` unless single-tenant | optional |
| `MICROSOFT_SYNC_REDIRECT_URI` | `https://www.bubaly.com/api/sync/microsoft/callback` | optional, recommended |

Two rules the preflight enforces, because both have already cost a production
outage:

- **Never assign an empty value.** `GOOGLE_SYNC_CLIENT_ID=` is *worse* than
  leaving it out: an absent value falls back to the legacy pair, a blank one
  defeats the fallback. Delete the variable instead of blanking it.
- **Never let whitespace ride along.** These are pasted by hand; a trailing
  newline survives the paste and Google answers `invalid_client`, which names
  nothing. Every reader now trims, and the preflight reports it.

Also register `https://www.bubaly.com` (and any preview host) as an **Authorized
JavaScript origin** on both clients.

`GOOGLE_SEARCH_CONSOLE_KEY` / `GOOGLE_SEARCH_CONSOLE_ACCESS_TOKEN` are the only
other `GOOGLE_*` variables the code reads. They belong to the marketing/SEO
integration, not to either OAuth client, and nothing here applies to them.

### Supabase side of sign-in

Supabase Dashboard → **Authentication → Providers → Google**: paste the **Bubaly**
client ID and secret there too. Supabase performs that exchange itself, so the
app's `GOOGLE_CLIENT_*` variables do not cover it — the same credentials have to
exist in both places.

---

## 4. Reading the errors

| What the user sees | What it actually means |
|---|---|
| `Error 400: invalid_request` | The `redirect_uri` sent was malformed — historically the literal `undefined/api/...` from an unset `NEXT_PUBLIC_APP_URL`, or an empty string. |
| `Error 400: redirect_uri_mismatch` | Well-formed, but not registered byte-exact on **that** client — check host, scheme, trailing slash, and that you edited the right one of the two clients. |
| `Error 403: access_denied` | Consent screen is in **Testing** and this account is not a test user. Publish the app (§2). Redirect URIs are irrelevant to this one. |
| `invalid_client` at the token exchange | Wrong secret, secret from the *other* client, or whitespace on the value. |
| `invalid_grant` on refresh | The grant is dead — expired (the 7-day Testing rule), revoked by the user, or issued to a different client. The app clears the stored token and asks for a reconnect. |
| `?error=not_configured` on `/api/sync/google/auth` | `googleSyncClientId()`/`Secret()` resolved empty — the pair is missing *and* the legacy fallback is missing or blank. |
| `?error=no_encryption_key` | `SYNC_TOKEN_KEY` is unset. Tokens fail closed rather than persisting in plaintext. |

---

## 5. Order of operations

1. `npm run verify:oauth` against the production values — fix every error it names.
2. Register the redirect URIs and JavaScript origins on both clients; **Save**.
3. Paste the **Bubaly** credentials into Supabase → Auth → Providers → Google.
4. Set the Vercel production environment variables; redeploy (env changes do not
   apply to an existing build).
5. Consent screen → **Publish app**.
6. Round-trip each flow live: sign in with Google; connect the read-only
   calendar; connect two-way sync. See
   `docs/runbooks/LB-006-provider-callback-smoke.md`.
7. Submit for verification to drop the unverified-app interstitial.

## 6. Rotation

Client secrets are rotated from the same Credentials page (add a new secret,
deploy it, then delete the old one — both are valid in between, so there is no
outage window). Anything that has appeared in a chat transcript, a ticket, or a
shared document should be treated as disclosed and rotated on that basis alone.
See `docs/runbooks/LB-003-service-credential-rotation.md` for the general
procedure.

# `GET /auth/callback` and `POST /auth/signout`: negative-path evidence

Local production builds only. **This is not production acceptance.** No live OAuth provider took part,
and no real sign-in was exchanged.

| | |
|---|---|
| Audit rows | `API-9A739F355ACF` (GET /auth/callback), `API-216181642979` (POST /auth/signout). Both are ⬜ NOT STARTED on main `bc147c76`. It also corroborates `ROLE-7394A5416880` and `ROLE-653C5C5D599A`, already ✅ PASS from a code read |
| Probes | local production build of **`fdcdb425a1175be87210681eeac5081ee2b47551`**, `next start` on `http://localhost:3115`, 2026-09-28 00:29 UTC |
| Served `Referrer-Policy` | local production build of **`62661cbc20e5ae8fb7e10a0e6889fd91132b8ade`**, `http://localhost:3116`, 2026-09-28 00:46 UTC |
| Still current on main `bc147c761ae7ebc5aff4b2627e18241593f61ac9`? | **Yes.** See [Staleness](#staleness) |

## What was sent and what came back

A helper printed the status and these headers: `Location`, `Cache-Control`, `Referrer-Policy` and
`Set-Cookie`. Cookie values were elided when printed.

```bash
B=http://localhost:3115
p(){ curl -s -o /dev/null -D - "$@" | grep -iE "^HTTP|^location|^cache-control|^referrer-policy|^set-cookie" \
  | sed 's/set-cookie: \([^=]*\)=[^;]*/set-cookie: \1=…/I' | tr '\n' ' '; echo; }
```

The redactions below are these:
- `<witness>` stands for the callback's admission witness, a base64 JSON of hashes derived from the
  local session.
- `<nonce>` stands for the sign-out intent UUID.

Neither value is recorded.

| # | Request | Answer | What it shows |
|---|---|---|---|
| 1 | `GET /auth/callback` (no code) | `307` → `/auth/complete?next=%2Fhome&admission=<witness>&error=auth`; `cache-control: private, no-store` | a missing code becomes `error=auth`, with no exchange attempted |
| 2 | `GET /auth/callback?code=abc123&next=//evil.example/x` | `307` → `/auth/complete?next=%2Fhome&admission=<witness>&code=abc123` | a protocol-relative (off-site) `next` is dropped for `/home`, so there is no open redirect |
| 3 | `GET /auth/callback?code=abc123&error=access_denied` | `307` → `…&error=auth` (the code is not forwarded) | a provider error wins over a code |
| 4 | `GET /auth/callback?code=ab%0Acd` | `307` → `…&error=auth` | a code with a control character is refused |
| 5 | `GET /auth/callback?code=a&code=b` | `307` → `…&error=auth` | two codes are refused |
| 6 | `GET /auth/callback?code=abc123&next=/dashboard/calendar` | `307` → `/auth/complete?next=%2Fdashboard%2Fcalendar&admission=<witness>&code=abc123` | control: a same-site `next` and one well-formed code pass through |
| 7 | `POST /auth/signout` with `Origin: https://evil.example` | `403`, `cache-control: no-store` | a cross-origin sign-out is refused |
| 8 | `POST /auth/signout` with `Sec-Fetch-Site: cross-site` | `403`, `cache-control: no-store` | refused on the fetch-metadata signal too |
| 9 | `POST /auth/signout` with its own `Origin` | `303` → `/auth/signout/complete?intent=<nonce>`; `set-cookie: bubaly_signout_intent=…; Path=/auth/signout/complete; Max-Age=60; HttpOnly; SameSite=strict`; `cache-control: no-store` | control: a same-origin post gets a 60-second, path-scoped, HttpOnly intent cookie. The route writes no auth cookie |
| 10 | `GET /auth/signout` | `405` | a link or preload cannot sign anyone out |

`Secure` is absent from the cookie in row 9 because the build was served over plain `http://localhost`.
The route sets it from `isSecureRequest`.

### The served referrer policy

On `fdcdb425`, rows 1 to 9 were served `Referrer-Policy: strict-origin-when-cross-origin`, although both
routes set `no-referrer` on their own responses.
- **Cause:** next.config's rule for every path replaced the header the routes set.
- **Fix:** #621 added a rule for exactly `/auth/:route(callback|signout)`, pinned by
  `tests/auth-routes-are-served-no-referrer.test.ts`.
- **Re-check** on a production build of `62661cbc`:

```
/auth/callback        Referrer-Policy: no-referrer
/auth/signout (POST)  Referrer-Policy: no-referrer
/auth/complete        Referrer-Policy: strict-origin-when-cross-origin
/                     Referrer-Policy: strict-origin-when-cross-origin
/login                Referrer-Policy: strict-origin-when-cross-origin
```

## Staleness

Nothing in either route's request path changed in a way that could change these answers between the
tested commits and main `bc147c76`:

- **`app/auth/callback/route.ts` and everything it imports:** `lib/auth/callback-witness-server.ts`,
  `lib/auth/callback-witness.ts`, `lib/auth/pkce-initiation.ts`, `lib/auth/redirect.ts` and
  `lib/billing/review-selection.ts`. All unchanged since `fdcdb425`.
- **`app/auth/signout/route.ts` and everything it imports:** `lib/auth/signout-bridge.ts`,
  `lib/auth/session.ts`, `lib/auth/revoke-session.ts`, `lib/auth/recovery-server.ts`,
  `lib/auth/recovery-cookies.ts`, `lib/auth/callback-witness.ts` and `lib/auth/pkce-initiation.ts`.
  All are unchanged, except `lib/database.types.ts`, which holds only types and is erased at build.
- **`next.config.mjs`:** unchanged since `62661cbc`.
- **`middleware.ts`:** changed after `fdcdb425`, but only by a branch taken for `/api/` paths (a
  signed-out script now gets `401` instead of a redirect). Neither route is under `/api/`.

The closure was computed by `staleness.py`, which comes with this evidence, and the middleware diff was
read by hand. So the probes were **not re-run**. The assignment was to re-run only affected checks, and
these are not affected.

## Limitations

- **The OAuth exchange itself is not covered.** No provider was configured, so no real authorization
  code was issued. The route only admits a code; the browser exchanges it on `/auth/complete`. A
  positive sign-in through Google or Apple has not been exercised here.
- **The sign-out completion is not covered.** This evidence stops at the bridge cookie and redirect.
  What `/auth/signout/complete` does with them is the page's row (`PAGE-398`), not this one.
- **Local only.** Production headers and behavior were not probed for this evidence.

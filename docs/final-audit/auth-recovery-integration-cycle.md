# Account recovery integration cycle

The discovery and contract review recorded AUTH-003 before these changes. This cycle connects the independent server verification, callback and rendered form lanes; it remains in progress. No live email or password operation has been performed.

## Request authority

`app/(auth)/auth/recovery/actions.ts` is the server-action boundary. Implicit link preparation receives explicit candidate tokens and delegates to the isolated provider verifier; it does not read or install an ambient session. The callback bridge stores a short-lived signed grant in an HttpOnly cookie scoped to `/auth`. A SHA-256 hash in the redirect must match that exact cookie before the bridge returns any grant or identity. The bridge remains readable until its expiry to support reload and repeated initialization. It is not a one-time credential.

The form may retain the signed grant in session storage, without passwords or bearer tokens. Both restored grants and password submissions require the current request's exact cookie token to pass the server helper's provider, subject, session and recent-authentication checks. Cookie `getSession` supplies only a candidate; it never establishes authorization by itself. The password helper receives the captured token and pins its provider write to it. A later ambient session change cannot substitute another account into that write. A missing or stalled cookie session never starts a password write. No action signs out the current user.

Malformed explicit links must not fall back to a remembered grant or a different signed-in user. Browser lifecycle guards, successful pair installation and uncertain-result behavior are being checked by the separate rendered-form lane. The legacy OTP compatibility limit and non-renewable 15-minute authority window are documented in `auth-recovery-contract-review.md` and `auth-recovery-server-cycle.md`.

## Executed checks

On 2026-09-12, Node 24.21.0 ran the action suite with the server-helper suite: **98 passed** (16 action cases and 82 helper cases). The action cases are orchestration tests with mocked helper/request boundaries, not SDK or live provider verification. They cover exact callback hash binding, missing/malformed bridge input, explicit-link failure without ambient fallback, account-switch refusal, exact-token forwarding, missing session, a 15-second held session followed by late completion without a write, and sanitized failures. Independent review caught transient session errors being described as account changes; the added case verifies that refresh outages report temporary unavailability. The independent server-helper suite supplies actual installed-SDK and signed-JWT verification evidence. A complete strict typecheck before the recovery UI additions passed; it does not cover those later files.

Combined typecheck, rendered recovery checks, complete regression and production build remain pending for the integrated source. SMTP receipt, deployed redirect allowlists, hosted password policies and actual recovery link consumption remain unverified. AUTH-003 is **IN PROGRESS**; this document does not declare a full recovery workflow passing.

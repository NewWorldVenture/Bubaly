# Incoming family reply identity compatibility

Baseline publication: `d1214d102eef20915189f42aaf5713e611d34858`.
Incoming main: `fdce273b` (PR 517).

The incoming change lets Contact Center replies use the resolved family's address as both From and Reply-To. Three files changed: the inbound email route, the email transport helper and identity tests. The email route conflicts with this branch's existing retained-message handling and accurate urgent-intake reply.

The integration preserves retained intake, paperwork and attachment recovery, planner handoff, the existing urgent reply text, and HTML escaping. Review found two defects: incoming From bypasses the configured sender domain, and the existing case-insensitive local-part lookup treats an underscore as a wildcard. A failed or skipped email also previously produced a misleading outbound timeline entry.

The repair will use the family From address only when its exact domain matches the configured sender, while always routing replies to the family's address. Display names and HTML text require safe formatting. Local-part lookup must match literal characters with case-insensitive identity. Outbound history will be written only after the provider accepts the reply. Auto-reply remains best effort after retained intake; this does not add durable outbound retry or guarantee final delivery. No SQL, dependencies or shared navigation are involved.

Focused identity, inbound email, provider failure and urgent-delivery regression checks will run before publication. The new hosted CI will establish combined build and regression evidence. Sender-domain verification and real email delivery are separate operational requirements.

Publication `d1214d10` received a successful Vercel status, but no CI or finance run registered because the incoming route conflict left the PR unmergeable. These checks are pending the integrated publication, not failed test runs.

Integrated application source: `9be771a891b9753badf33901bc82a666b1a100e9`, with parents `d1214d10` and `fdce273b`. Six source files changed: three production files and three test files. No SQL, dependency, shared navigation or locale files changed. Exact committed hashes and exported boundaries are recorded in `discovery/incoming-family-reply-inventory.json`.

The original lookup failed five of eight new checks, including wrong-family underscore routing, a wildcard neighbor and malformed successful results. The repair escapes LIKE metacharacters, verifies returned ownership and retains mixed-case exact lookup. The installed database SDK and intercepted HTTP exercise the query contract; the fixture's LIKE model does not establish actual PostgreSQL execution.

The frozen combined email regression passes all 266 tests across 17 files, including eight lookup checks, 23 sender identity cases and seven route execution cases. Actual route code with synthetic storage verifies retained intake and no false sent timeline for rejected, skipped, missing, thrown or pending acceptance; success stores the precise plain-text response with the family's Reply-To. Urgent mail retains its localized escaped reply and in-app receipt/notification. Identity tests exercise the actual transport with intercepted fetch and restored environment state. Independent integration review found no blocking regression.

Strict TypeScript, lint with four existing warnings, localization and query audits pass on the combined source. Query coverage remains 491 tables, 77 functions and 143 API routes. The earlier complete 14,598-test run and production build apply to application `966f08f3`; the new hosted run will establish complete regression and build evidence for `9be771a8`. Logs are `C:/Users/Daniel/AppData/Local/Temp/bubaly-family-reply-combined-20260912.{json,log}` and `bubaly-email-integration-final-private-<types|lint|i18n|queries>-20260912.log` in the same directory.

Full deployed family email intake, provider delivery and verified sender-domain configuration remain open. The route continues to acknowledge retained intake when its best-effort auto-reply fails; no durable email emission receipt or replay deduplication is introduced.

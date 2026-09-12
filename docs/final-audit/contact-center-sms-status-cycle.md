# Contact Center SMS reply status callback — 2026-09-12

## Provider contract reviewed before implementation

Twilio documents that inbound SMS/MMS and some historical accounts differ in whether a reply uses the TwiML `<Message>` `action` or `statusCallback` attribute. Set both to the same absolute URL with `method="POST"`. The callback reports a Message SID and status; the documented SMS lifecycle includes queued, sending, sent, delivered, undelivered and failed. A local TwiML response alone is not provider acceptance or handset delivery. [Twilio Message verb](https://www.twilio.com/docs/messaging/twiml/message).

The proposed endpoint is `POST /api/contact-center/sms/status?receipt=<UUID>&token=<emission UUID>`. Request authentication covers the configured application origin, exact callback path and unmodified query string, plus every received form parameter in sorted order. Host/forwarding headers do not select the trusted origin. Extra provider form fields remain part of signature verification; ambiguous duplicate fields are rejected. [Twilio request security](https://www.twilio.com/docs/usage/security).

Twilio status callbacks use URL-encoded form POSTs and may omit some standard properties. `MessageSid`/`MessageStatus` and legacy `SmsSid`/`SmsStatus` aliases must agree when both appear; optional From, To and AccountSid must match stored emission identity. Callbacks can arrive out of order, and a successful handler should acknowledge them with HTTP 200. The private receipt helper must preserve monotonic status, treat replay as a no-op, and never infer delivery from an HTTP response generated locally. [Twilio status tracking](https://www.twilio.com/docs/messaging/guides/track-outbound-message-status).

## Ownership and verification plan

This lane owns the new status route and `tests/contact-center-sms-status.test.ts`. The API lane owns private receipt creation/status transitions; root owns exact public middleware allowance and TwiML callback attributes. No family authority comes from query parameters. The private helper must bind receipt family, emission token, provider SID and optional account/phone observations before changing state. Invalid identity is rejected; required storage failures return 503 without a delivery claim.

Tests will execute the actual signed route with synthetic HMAC inputs, malformed/forged requests, duplicate/reordered status events and required persistence failures. Private helper integration cases will use its real implementation once available. No SQL, external provider operation, new dependency, private clean-install mutation or live credentials are needed. Initial test/implementation results are pending.

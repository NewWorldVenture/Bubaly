# Contact Center SMS reply cycle

The user requested text messaging next on 2026-09-12. The actual callback and middleware were exercised through the existing intercepted fixture in `tests/contact-center-callback-boundary.test.ts`, before changing this route. Node 24.21.0 ran all 34 cases successfully; two added cases deliberately characterize current defects, not desired passing behavior or live delivery.

- With concierge replies enabled, two identical signed callbacks save one inbound row and submit one planner request, but return `<Message>Thank you</Message>` twice and save two outbound rows. The existing durable urgent-alert receipt does not cover these automatic TwiML replies.
- A signed callback with `Body=STOP` and `OptOutType=STOP` still runs the concierge and returns an automatic reply. Twilio documents that an `OptOutType` callback means its configured Advanced Opt-Out handler has already replied. The app should not add an unrelated concierge response. [Twilio Advanced Opt-Out](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out).

These are actual application/fixture executions with synthetic phone numbers and an in-memory persistence implementation. No real SMS was sent. A returned TwiML message is an instruction to the provider, not proof of acceptance or handset delivery.

The provider-handled control defect is repaired: after signature validation, exact `OptOutType` values STOP, START and HELP return empty TwiML before household reads, concierge execution or planner submission. The focused rerun passed **37 cases**, including each control and a forged control rejected with 401. This honors the provider's completed control response; it does not implement a new CRM consent ledger or marketing sender.

The automatic reply replay defect remains reproduced and unrepaired. Its characterization intentionally asserts the observed duplicate behavior, so its passing test is not counted as a passing workflow. Durable reply reservation and ambiguous-response handling still need design and execution checks. The complete SMS workflow remains **IN PROGRESS**.

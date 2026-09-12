# Guardian routing policy reads

Status: IN PROGRESS. Source discovery at `68f1a8f5`. Permanent records: `LIBRARY-5BA7FEA22007`, `API-BBD0A5DB630F`, `CALLBACK-07F1FB3AED21`, and `FLOW-DDE6E8974B46`. Contact Center's `SMS-001` remains a separate delivery workflow.

## Discovered failure

`lib/guardian/pipeline.ts` ignores returned errors from contact and member-profile reads, and converts a failed rules read into an empty list. The pipeline then produces a normal decision without the configured trust or routing policy. The existing pipeline fixture explicitly accepts the rules-error fallback. This is source-backed defect discovery; new failure-injection execution is pending.

SMS currently classifies before the first communication write. Throwing on unavailable policy alone would leave no retained inbound body. A saved row also currently bypasses classification, so a new pending receipt must be distinguished from an already decided receipt before notification.

## Bounded implementation and verification plan

- Required policy reads must distinguish verified absence from returned errors, throws, incomplete or malformed receipts and timeouts. Unavailable policy must produce no routing decision or downstream AI work.
- Preserve healthy routing precedence and the separately documented emergency-versus-explicit-block question.
- Use the existing schema to persist and verify an owned, neutral pending communication before classification. No new SQL is needed or authorized.
- Retry pending classification after recovery; replay a verified decided receipt without reclassifying it. Verify conditional decision writes before notification or completion, and preserve the current callback lease ownership.
- Exercise the actual pipeline and signed SMS route under controlled provider/database failures. Preserve the existing lease regression suite, and verify voice and WhatsApp callers handle policy unavailability explicitly.

The implementation will be prepared in an isolated worktree while the meal acceptance revision remains unchanged. This plan does not claim that the defects are fixed. Pending storage alone does not create an autonomous queue worker or guarantee provider redelivery, and separate lease and communication writes are not a database transaction.

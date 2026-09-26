# Social publish concurrency and outcome cycle

SOCIAL-002 remains in progress while provider/database verification and recovery work continue. Consumer review and combined local gates pass for source6094eb04; see social-verification-checkpoint.md. No live posts were submitted.

## Executed defects

The production publish pipeline, a stateful Supabase query fixture and a confirming provider fixture reproduced two concurrent invocations sending twice and creating two receipts for a single target. The original pipeline also rolled up only the current attempt, losing earlier platform successes, and changed the parent to publishing before discovering that no eligible targets existed.

An independent consumer audit reproduced a second path through the actual studio component, create action, installed PostgREST client and pipeline: after an uncertain attempt, invoking the retained Publish now handler created another post ID and made another provider request. Per-post claims alone cannot prevent that editor defect. The consumer cycle records its repair and browser evidence separately.

Independent pipeline review additionally identified a published target and failed target sharing the same account. The first test fixture inadvertently used that invalid arrangement as its earlier-success control. The repaired control uses a distinct account; a separate regression rejects duplicate accounts across all persisted target rows before sending. The existing schema has no unique post/account target constraint.

## Repairs

Required post, target, variant and account reads complete before provider work. Target and variant pages traverse to an empty page, including with a smaller API row cap; explicit bounds and cursor checks prevent incomplete or unbounded work. Missing accounts, ambiguous variants, duplicate target accounts and failed targets carrying provider confirmations fail before dispatch.

The post takes a conditional status/timestamp claim carrying a job ID in its existing metadata. Each target additionally takes its own conditional claim. Concurrent losers cannot send. Target and parent completion writes require that same claim. A repeated already-published or in-flight invocation does not create another job or overwrite existing publication dates.

Only consistent provider success with a nonempty provider object ID can complete a target. Exceptions, uncertain acceptance and contradictory receipts retain publishing status. There is no expiry that automatically resends an uncertain operation. Confirmed receipts are saved before target completion; either persistence failure retains the claim for review. The parent rolls up every persisted target, preserving earlier publication dates. Published plus skipped/canceled is partial success.

The X connector receives the actual family, account, actor and post kind so it can enforce its private token boundary. Actual provider acceptance remains separate from controlled connector fixtures.

## Scoped regression evidence

`tests/social-publish-execution.test.ts`: 28 actual pipeline/query-state cases pass, covering concurrency, preserved successes, partial outcomes, repeated/empty invocations, invalid/uncertain receipts, connector throws, returned/thrown receipt failures, completion-write failure, required-read denial, cross-family/deleted posts, claim replacement/cancellation, duplicate accounts, stale parent status, row caps and target-volume bounds.

The pipeline and content suites together pass 45 cases. Catalogue integrity adds 55 passing cases. Scoped pipeline/content/execution-test lint passes. The obsolete static assertion requiring raw connector exception logging was replaced with the safe exception/uncertainty contract; actual X execution tests also exercise that boundary. Combined checks pass as recorded in social-verification-checkpoint.md.

## Limits still requiring verification or work

- Execution fixtures exercise repository control flow and conditional query semantics; they are not live Postgres/RLS or provider acceptance proof.
- A process lost after taking a claim can leave publishing status for review. A saved confirmed receipt remains available, but automatic recovery/reconciliation is not implemented in this cycle.
- Current scheduling has creation/read surfaces but no verified social schedule dispatcher or cancellation workflow.
- The separate restrictive-role DELETE policy defect remains a release blocker. No SQL was authored, edited or applied.
- The complete Social workflow and second whole-application regression are not signed off.

# Marketing push outcomes — PUSH-006

PUSH-006 was recorded as High / IN PROGRESS before implementation. This cycle executes the actual marketing server action, core push sender and server-rendered page with persisted synthetic storage and controlled provider results. It does not send live notifications or claim handset delivery.

## Reproduced failures

Five initial execution cases failed against the previous implementation: all failed or unconfigured sends appeared as sent; partial acceptance appeared complete; two devices belonging to one recipient produced “200%”; and a later device read failure after an accepted send made the entire campaign retryable. An independent consumer review also reproduced two problems during repair: intentional user opt-outs were classified as delivery failures, and deleting an active campaign hid its review record while subsequent device requests continued.

## Repair

A conditional status and update-time claim reserves one sender. A versioned attempt record is persisted before entering the provider boundary; all subsequent outcome writes require the same attempt. Only a failure proven to precede dispatch may make the whole campaign retryable. A typed preparation error in the core sender identifies failed required consent reads before any device request. Crashes, uncertain outcomes and failed final writes retain a review state; legacy failed attempts also require review instead of automatic replay.

Campaign counts now distinguish provider-accepted device requests, failed operations, skipped devices, excluded users and removed devices. The page no longer divides device outcomes by recipient users. Intentional consent exclusions permit a completed campaign and are displayed separately. Failed, unconfigured or partial outcomes remain available for review. “Provider accepted” describes the evidence available; it is not a claim of physical delivery.

Active or uncertain records cannot be deleted through the page or the server action. Deletion of a settled draft or completed campaign remains available and is conditioned on the current status and update timestamp; migration0063 already maintains that timestamp on every update. No database schema or policy was changed.

## Verification

The root execution suite includes provider failure/unavailability, mixed outcomes, device/user units, failure after acceptance, simultaneous send actions, failed dispatch-claim persistence, failed result persistence, replacement claims and legacy failed campaigns. Independent consumer cases execute real English and French translation interpolation, intentional exclusions, deletion while a send is held, uncertain outcome retention and ordinary deletion controls. Existing recipient, parent-consent, suppression and complete-audience tests remain included in related regression.

Combined fourth-cycle unit, type, lint, build and browser results will be recorded in the verification checkpoint. The targeted tests use real application modules with synthetic database/provider boundaries; they do not establish live RLS, provider configuration or end-to-end physical-device delivery.

Per-device durable receipts, selective retry/reconciliation, complete pagination of every user's device list and older page localization gaps remain separate audit obligations. Holding an uncertain campaign prevents an unsafe replay but does not establish the disposition of an individual device request.

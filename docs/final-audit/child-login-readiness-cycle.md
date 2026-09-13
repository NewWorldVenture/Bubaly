# Child login readiness investigation

AUTH-002 remains IN PROGRESS. Hosted run 34714322612 on PR merge revision 40eb05d4 (cc915684 plus dace0266) passed with 1,055 browser passes and one flaky child PIN journey. Its retry passed; the first attempt timed out before the first device's submit, waiting for a disabled Sign in button. No artifact exists. The route did not begin child authentication in the observed failed step.

## Pre-edit plan

The child form's server-rendered inputs can accept edits before hydration, while its submit state begins with empty React values. This is a plausible readiness race, not a proven explanation of the CI failure. Reproduce it with the actual server-rendered component and delayed browser hydration in a separate checkout. If reproduced, keep credential fields non-editable until client readiness so early edits cannot be lost; preserve input validation, ownership guards, the real durable child journey and existing timeouts. Do not force clicks or loosen the test to hide the failure.

Source is prepared separately from the frozen Guardian/assistant revision 1aa4d6fb. Controlled component evidence and hosted durable authentication evidence will remain distinct. Reopening, token renewal and production session configuration are separate verification obligations.

## Results

The actual server-rendered form reproduces the defect under delayed React hydration: early input stays visible, but its values never reach React and Sign in remains disabled. The matching hydration-first control submits once. Both characterization cases pass with zero hydration errors. This proves a real defect consistent with the historical symptom; absent historical DOM evidence, it does not prove the sole cause of that CI failure.

Repair `1dfddb23` is integrated as `48e7e9e1`. Credential fields, reveal and submit wait for the existing client layout effect. A normal fill started before hydration now waits until the first edit can reach React. Validation and rejected-attempt retry behavior pass. The two new cases and 17 existing child browser boundary cases pass in 3.1 seconds; 18 related action tests, scoped lint and strict types pass. Independent review found no blocker. Initial username autofocus may be lost; normal entry works, and password-manager autofill is not claimed.

Evidence: `Temp/bubaly-child-readiness-baseline-20260912.log`, `Temp/bubaly-child-readiness-repair-20260912.log`, `Temp/bubaly-child-readiness-units-20260912.log`, and `Temp/bubaly-child-readiness-repair-20260912-evidence.md`. The full integrated unit gate passes 1,188 files / 14,442 tests in 42.07 seconds. The production build passes with 251 static pages and a 43-second compile; strict post-build types, lint, localization and query audits pass. Four baseline lint warnings remain. The compiled build-info route contains the exact `48e7e9e1` revision, and package/lockfile hashes are unchanged. Full gate logs use `Temp/bubaly-child-readiness-final-private-<gate>-20260912.log`. The hosted durable journey remains pending. Existing durable test assertions and timeouts are unchanged.

# Child login readiness investigation

AUTH-002 remains IN PROGRESS. Hosted run 34714322612 on PR merge revision 40eb05d4 (cc915684 plus dace0266) passed with 1,055 browser passes and one flaky child PIN journey. Its retry passed; the first attempt timed out before the first device's submit, waiting for a disabled Sign in button. No artifact exists. The route did not begin child authentication in the observed failed step.

## Pre-edit plan

The child form's server-rendered inputs can accept edits before hydration, while its submit state begins with empty React values. This is a plausible readiness race, not a proven explanation of the CI failure. Reproduce it with the actual server-rendered component and delayed browser hydration in a separate checkout. If reproduced, keep credential fields non-editable until client readiness so early edits cannot be lost; preserve input validation, ownership guards, the real durable child journey and existing timeouts. Do not force clicks or loosen the test to hide the failure.

Source is prepared separately from the frozen Guardian/assistant revision 1aa4d6fb. Controlled component evidence and hosted durable authentication evidence will remain distinct. Reopening, token renewal and production session configuration are separate verification obligations.

## Results

Pending reproduction. Sanitized investigation: `Temp/bubaly-child-pin-ci-flake-34714322612-evidence.md`.

# Incoming assistant and Contact Center compatibility

Incoming main: 217c7be464c30f4f10a1bf672a07b5a9fca67e6a, after 9719a486. Integrated into the isolated checkout at b0ded93f. No incoming SQL was authored, edited or applied locally.

## Pre-edit findings and plan

The incoming Contact Center change adds a broad public prefix, while this branch already exposes exactly its four signed or secret-authenticated callback paths. Preserve the exact allowlist and update the incoming static assertions to test those paths. Execute the real middleware fixture for all four callbacks and protected neighbors; do not replace the branch's session, logout, cookie or child-action logic.

The incoming assistant endpoints `/api/assistant` and `/api/assistant/alexa` authenticate linked-device tokens in their handlers, but are absent from middleware's public-route exemptions. Cookie-less assistant requests therefore cannot reach their intended authorization. Register only these two exact paths after checking their handler authorization. Exercise their reachability and protected descendants through actual middleware, and run the incoming token/assistant tests. This does not authorize a broad assistant prefix or bypass the handlers' token checks.

Onboarding changes reuse the established family and add optional email-address provisioning after durable completion. Inspection found no changed authentication or session ownership calls. The optional provisioning reads have no explicit timeout and remain a separate availability obligation.

Root owns the permanent inventory and audit status updates. Both callback-boundary and assistant reachability records remain IN PROGRESS until execution verifies the resolution. Incoming assistant/library features require their own full workflows; their discovery or passing units do not complete that audit.

## Results

Pending targeted reproduction, fix, related regressions and combined hosted checks.

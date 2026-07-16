# Product Launch Audit Ledger

This is the issue-level evidence ledger for launch. Each entry includes the required service, route,
role, scenario, severity, launch impact, root cause, resolution, Supabase impact, tests, validation,
commit, status, and remaining dependency. New findings must be added before or with their repair.

## Resolved Issues

### PLA-0397 - Contact Timeline hid contact, interaction, and communication read failures as missing history

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/dashboard/contacts/[id]`.
- Finding: contact lookup failures could look like a missing contact, while interaction and communication failures rendered an empty timeline.
- Repair: the route now preserves all three Supabase errors and returns a retryable page failure before building relationship health or timeline views.
- Evidence: focused Contact Timeline boundary suite (1 assertion), full 503 test files/3,263 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `ae763b67`.
- Remaining launch gate: validate authenticated family RLS, contact ownership, communication availability, and deployed retry behavior; broader dashboard and deployment gates remain open.

### PLA-0396 - Autonomous Family Management hid signal and automation read failures as healthy defaults

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/dashboard/autonomous-family-management`.
- Finding: family signal, recommendation, automation-rule, and automation-run reads could fail while monitoring, approval, and risk controls rendered zero or empty states.
- Repair: the shared signal collector now preserves required query errors, and the route returns a retryable page failure before deriving metrics, recommendations, or approval controls.
- Evidence: focused Autonomous Family Management boundary suite (1 assertion), full 502 test files/3,262 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `f04895cd`.
- Remaining launch gate: validate authenticated family RLS, signal and automation availability, approval behavior, and deployed retry behavior; broader dashboard and deployment gates remain open.

### PLA-0395 - Family Assistant hid context and count failures as zero signals

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/dashboard/agents`.
- Finding: calendar, meal, member, activity, and ten count reads could fail while agent briefings rendered zero operational signals.
- Repair: all required context and count results now retain their errors and the route returns a retryable page failure before deriving briefings.
- Evidence: focused Family Assistant boundary suite (1 assertion), full 501 test files/3,261 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `d43b15c4`.
- Remaining launch gate: validate authenticated family RLS, agent context availability, reasoning behavior, and deployed retry behavior; broader dashboard and deployment gates remain open.

### PLA-0394 - Family Intelligence hid signal read failures as an empty intelligence screen

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/dashboard/family-signals`.
- Finding: the family-signal query could fail while the route rendered no active or hidden intelligence signals.
- Repair: the Supabase error is checked before deriving active/hidden signal views; failures return a retryable page state.
- Evidence: focused Family Intelligence boundary suite (1 assertion), full 500 test files/3,260 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `384acfbd`.
- Remaining launch gate: validate authenticated family RLS, signal availability, and deployed retry behavior; broader dashboard and deployment gates remain open.

### PLA-0393 - Deals hid listing read failures as no standout deals

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/marketplace/deals`.
- Finding: the deal-feed listing query could fail while price-coach logic rendered “No standout deals right now.”
- Repair: the Supabase error is checked before building comparable price bands or rendering the empty state; failures return a retryable page state.
- Evidence: focused Deals boundary suite (1 assertion), full 499 test files/3,259 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `071bfd7c`.
- Remaining launch gate: validate authenticated marketplace reachability, listing availability, price-coach data, and deployed retry behavior; broader payment and deployment gates remain open.

### PLA-0392 - Selling hid listing and seller-signal read failures as zero activity

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/marketplace/selling`.
- Finding: the listing query and six seller-signal queries could fail while the seller cockpit rendered zero listings, offers, questions, or handoffs.
- Repair: all required listing and signal results are checked before deriving attention rankings or rendering the empty seller state; failures return a retryable page state.
- Evidence: focused Selling boundary suite (1 assertion), full 498 test files/3,258 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `db158e01`.
- Remaining launch gate: validate authenticated seller RLS, signal-table availability, buyer/seller workflows, and deployed retry behavior; broader payment and deployment gates remain open.

### PLA-0391 - Live Auctions hid listing read failures as an empty marketplace

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/marketplace/auctions`.
- Finding: the marketplace listing query could fail while the route rendered “No live auctions right now” and zero operational stats.
- Repair: the Supabase error is checked before deriving auction stats or rendering the empty state; failures return a retryable page state.
- Evidence: focused Live Auctions boundary suite (1 assertion), full 497 test files/3,257 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `f86dd8a2`.
- Remaining launch gate: validate authenticated family reachability, marketplace RLS, listing availability, and deployed retry behavior; broader payment and deployment gates remain open.

### PLA-0390 - Referrals hid settings and activity read failures as defaults or no activity

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/admin/marketing/referrals` and shared referral config reads.
- Finding: referral settings errors fell back to defaults and referral-row errors rendered no activity, leaving the admin dashboard actionable with incomplete state.
- Repair: added a status-preserving config read helper and require both config and referral reads to succeed before metrics, settings, or activity render.
- Evidence: focused Referrals boundary suite (1 assertion), full 496 test files/3,256 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `2b06e789`.
- Remaining launch gate: validate live Super Admin authorization, referral settings/activity availability, and deployed retry behavior; Auth Admin and broader launch blockers remain open.

### PLA-0389 - New Campaign hid segment read failures as an unfiltered audience selector

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/admin/marketing/campaigns/new`.
- Finding: the `marketing_segments` query could fail while campaign creation rendered a “No segment” fallback and allowed an unfiltered campaign.
- Repair: the Supabase error is checked before rendering the campaign form; failures return a retryable page state instead of silently removing audience targeting.
- Evidence: focused New Campaign boundary suite (1 assertion), full 495 test files/3,255 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `d600ad7c`.
- Remaining launch gate: validate live Super Admin authorization, segment availability, and deployed retry behavior; Auth Admin and broader launch blockers remain open.

### PLA-0388 - Social Providers hid provider-catalog read failures as enabled defaults

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/admin/social/providers`.
- Finding: the `social_providers` query could fail while every capability card defaulted to “DB enabled: yes.”
- Repair: the Supabase error is checked before building the enabled-provider map; failures return a retryable page state.
- Evidence: focused Social Providers boundary suite (1 assertion), full 494 test files/3,254 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `51423350`.
- Remaining launch gate: validate live Super Admin authorization, provider catalog availability, and deployed retry behavior; Auth Admin and broader launch blockers remain open.

### PLA-0387 - Admin Settings hid administrator-count read failures as zero access holders

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/admin/settings`.
- Finding: the `super_admins` count could fail while the page rendered zero administrators and presented the system as readable.
- Repair: the Supabase error is checked before building system status; failures return a retryable page state.
- Evidence: focused Admin Settings boundary suite (1 assertion), full 493 test files/3,253 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `0f91564a`.
- Remaining launch gate: validate live Super Admin authorization, settings table availability, and deployed retry behavior; Auth Admin and broader launch blockers remain open.

### PLA-0386 - Admin Management hid administrator read failures as zero admins

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/admin/admins`.
- Finding: the `admin_users` query could fail while the page rendered zero administrators and retained access-management controls.
- Repair: the Supabase error is checked before calculating role counts, filters, or admin-management controls; failures return a retryable page state.
- Evidence: focused Admin Management boundary suite (1 assertion), full 492 test files/3,252 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `b465cf71`.
- Remaining launch gate: validate live Super Admin authorization, admin table availability, and deployed retry behavior; Auth Admin and broader launch blockers remain open.

### PLA-0385 - Social Usage hid usage-event read failures as an empty meter

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/admin/social/usage`.
- Finding: the usage-event query could fail while the page rendered no metering activity, masking an unavailable operational feed.
- Repair: the Supabase error is checked before calculating totals or rendering the empty state; failures return a retryable page state.
- Evidence: focused Social Usage boundary suite (1 assertion), full 491 test files/3,251 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `ee26e70c`.
- Remaining launch gate: validate live Super Admin authorization, usage table availability, and deployed retry behavior; Auth Admin and broader launch blockers remain open.

### PLA-0384 - Social Audit hid audit-log read failures as an empty history

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/admin/social/audit`.
- Finding: the audit-log query could fail while the page rendered “No audit entries yet,” masking an unavailable operational history.
- Repair: the Supabase error is checked before rendering the empty state or audit rows; failures return a retryable page state.
- Evidence: focused Social Audit boundary suite (1 assertion), full 490 test files/3,250 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `80a790c6`.
- Remaining launch gate: validate live Super Admin authorization, audit-trigger table availability, and deployed retry behavior; Auth Admin and broader launch blockers remain open.

### PLA-0383 - Exit-Intent hid offer read failures as an empty editor

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/admin/marketing/exit-intent`.
- Finding: the offer query could fail while the page rendered zero offers and kept create, activate, pause, and delete controls available.
- Repair: the Supabase error is checked before calculating offer metrics or rendering CRUD controls; failures return a retryable page state.
- Evidence: focused Exit-Intent boundary suite (1 assertion), full 489 test files/3,249 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `03012c8c`.
- Remaining launch gate: validate live Super Admin authorization, marketing table availability, and deployed retry behavior; Auth Admin and broader launch blockers remain open.

### PLA-0382 - Personalization hid rule read failures as an empty editor

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/admin/marketing/personalization`.
- Finding: the rule query could fail while the page rendered no rules and kept create, activate, pause, and delete controls available.
- Repair: the Supabase error is checked before grouping rules by slot or rendering CRUD controls; failures return a retryable page state.
- Evidence: focused Personalization boundary suite (1 assertion), full 489 test files/3,249 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `03012c8c`.
- Remaining launch gate: validate live Super Admin authorization, marketing table availability, and deployed retry behavior; Auth Admin and broader launch blockers remain open.

### PLA-0381 - Competitive Intelligence hid CRUD read failures as an empty dataset

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/admin/marketing/competitive`.
- Finding: competitor, keyword, or backlink read failures could be masked while active CRUD controls remained available over empty collections.
- Repair: all three Supabase results are checked before rendering collections or CRUD controls; thrown failures also return a retryable state.
- Evidence: focused Competitive Intelligence boundary suite (1 assertion), full 487 test files/3,247 tests, typecheck, lint, clean 250-route build, �nw��$z{-���jםV�6��vV@��FW7G2'V��FW7G2�v��WB�&VB�&�V�F'��FW7B�G6�2f�7W6VBFW7G2��gV��CS�f��R�2�sr�FW7B7V�FS�G�V6�V6��Ɩ�C�FWV�FV�7�VF�C�&�GV7F���'V��C�F�fb6�V6���fƖFF���Wf�FV�6S�f�����6�vFR76VBv�F�&�GV7F���FWV�FV�7�gV��W&&�ƗF�W2�B#SvV�W&FVB&�WFW0��7FGW3�&W6��fVB��6�FS�ƗfRv��WB�$�2�&��R�6��7W'&V�7���B'&�w6W"Wf�FV�6R&V����V���&V�����rFWV�FV�6�W3�W�V7WFR��vW"��V�&W"v��WB���fW7B�v�gB�&'�6�GFW"�6���B�v��WB�&V6��6�ƖF�����BFV��B֗6��F���G&���2v��7BFW���VB7W&6P�222��3#�7G&�R7V'67&�F���vV&�����v��&VB&��"&��Ɩ�r7FFRf��W&W0���F��W7F��##b�r�RC��W&�6��Wu���&���6W'f�6S�7G&�R7V'67&�F���vV&����7��6�&�旦F����Bw&�wF��W'G0��&�WFS����vV&����2�7G&�V ��ffV7FVBf��W3����vV&����2�7G&�R�&�WFR�G6�FW7G2�vV&�����W'6�7FV�6R�&�V�F&�W2�FW7B�G6 ��&��S����rf֖ǒ�B7WW"F֖��W&F� ��66V�&���&��Ɩ�r�7W7F��W"�B&��"�7V'67&�F���&VG2&�F�vWF�W"�'WB��ǒF�R&��Ɩ�r�7W7F��W"W'&�"v26�V6�VB&Vf�&R7V'67&�F���W'6�7FV�6R�B6��fW'6����6�W&�6��&�6����6WfW&�G�� ���V�6���7C�7G&�RWfV�G26�V�Bw&�FR7V'67&�F���7FFRv�F��V�G'W7FVBG&�6�F���&6VƖ�R�"f��F�G&�vvW"67W&FRw&�wF��W'G0��&��B6W6S�&��%7V'67&�F���W'&�&v2F�66&FVC���V�BWF��F���f��W&W2vW&R6��V�Fǒ7v���vV@��&W6��WF����&�F�&WV�&VB7FFR&VG2��rf��6��6VBF�&�Vv�F�R&W&�6W76&�RvV&����W'&�"F����V�BWF��F���f��W&W2&R��vvV@��7W&6R��7C���66�V�6��vS�W��7F��rWfV�B6����f��Ɨ�F����Bf֖ǒ�66�VB7V'67&�F���W'6�7FV�6R&V������6P��FW7G2'V��FW7G2�vV&�����W'6�7FV�6R�&�V�F&�W2�FW7B�G6�FW7G2�7G&�R�w&�wF���W'G2�6��G&7B�FW7B�G6��BFW7G2�7G&�R�vV&�����&W���6��G&7B�FW7B�G6�f�7W6VBFW7G2��G�V6�V6��Ɩ�C�F�fb6�V6���fƖFF���Wf�FV�6S�f�7W6VBfƖFF���76W3�gV��vFR�BƗfR7G&�RWf�FV�6R&V����V���7FGW3�&W6��fVB��6�FS�ƗfR&W����FV��FV�7��B&�f�FW"Wf�FV�6R&V����V���&V�����rFWV�FV�6�W3�W�V7WFR����FW7G'V7F�fR7V'67&�F���ƖfV7�6�R�&W���&WG'���Bw&�wF���W'BG&���2��7G&�RFW7B��FP�222��3#"����v�6R7&��6��VB7&VF�G2v�V�7V'67&�F���vF��r&VBf��V@���F��W7F��##b�r�RC�B�W&�6��Wu���&���6W'f�6S�66�VGV�VBv��WB���v�6RWF��F�����&�WFS����7&���v��WB����v�6V ��ffV7FVBf��W3����7&���v��WB����v�6R�&�WFR�G6�FW7G2�7&���v��WB����v�6R�W'6�7FV�6R�FW7B�G6 ��&��S�f֖ǒ��vW"�&V�B�6���B&V6��V�B��B66�VGV�VB7&��v�&�W ��66V�&���f��VB7V'67&�F���2&VB&�GV6VB�V�G�����6��B�f֖ǒVƖv�&�ƗG�6�V�B&RG&VFVB2g&VR�B7&VF�G26��V@��6WfW&�G�� ���V�6���7C�66�VGV�VB���v�6W26�V�BF�6V"v�F��WB&WG'�&�Rf��W&R6�v����&��B6W6S�F�R7V'67&�F������vF��rW'&�"v2F�66&FV@��&W6��WF����7V'67&�F���&VBW'&�'2��rf��F�R7&��F�&�Vv��G2SW'&�"F��66�VGV�R6����B7&VF�B&���&6�&V���6�V6�V@��7W&6R��7C���66�V�6��vS����v�6R�B7V'67&�F���f֖ǒ66�W2&V���V�6��vV@��FW7G2'V��FW7G2�7&���v��WB����v�6R�W'6�7FV�6R�FW7B�G6�FW7G2�7&���WF��FW7B�G6��f�7W6VBFW7G2��G�V6�V6��Ɩ�C�F�fb6�V6���fƖFF���Wf�FV�6S�f�7W6VBfƖFF���76W3�gV��vFR�BƗfR7&���$�2Wf�FV�6R&V����V���7FGW3�&W6��fVB��6�FS�ƗfR66�VGV�VBW�V7WF���&V���2�V���&V�����rFWV�FV�6�W3�W�V7WFR�6��FVB�WFvR�GWƖ6FR�'V���B�VFvW"�$�2G&���0�222��3#2�F�vW7B7&��2��Bf֖ǒ�BFVƗfW'�f��W&W22�W&�6V�G0���F��W7F��##b�r�RC���W&�6��Wu���&���6W'f�6S�6��&R&V֖�FW"�BvVV�ǒF�vW7B66�VGV�VBV���v�&�f��w0��&�WFW3����7&���6��&R�&V֖�FW'6����7&���vVV�ǒ�F�vW7F ��ffV7FVBf��W3����7&���6��&R�&V֖�FW'2�&�WFR�G6����7&���vVV�ǒ�F�vW7B�&�WFR�G6�FW7G2�F�vW7B�7&���&VB�&�V�F'��FW7B�G6 ��&��S�f֖ǒ�V�&W"�f֖ǒF֖���B66�VGV�VB7&��v�&�W ��66V�&���f֖ǒ�WF�F֖��fVGW&R&VG2f��VB'WBF�R7&��76V�&�VBV�G�FF�"&V6��V�G3�f��VBV���FVƗfW'�F�B��B6��vRF�R&W7��6R7FGW0��6WfW&�G�����V�6���7C�&V֖�FW'2�BF�vW7G26�V�B&R֗76VBv���R�W&F���26r�&V�Fǒ7V66W76gV��W&��6V�B'V���&��B6W6S�7W&6R&W7V�BW'&�'2vW&RF�66&FVB�BV���6V�Bf��W&W2vW&R��B6�V�FV@��&W6��WF����&WV�&VB&VG2��rf��v�F�S�W"�f֖ǒ&VBf��W&W2&R6�V�FVB��B'F��V���FVƗfW'�&WGW&�2S"v�F�6V�B�f��VB6�V�G0��7W&6R��7C���66�V�6��vS�W��7F��rf֖ǒ�66�VBVW&�W2&V���V�6��vV@��FW7G2'V��FW7G2�F�vW7B�7&���&VB�&�V�F'��FW7B�G6�FW7G2�7&���WF��FW7B�G6�bf�7W6VBFW7G2��G�V6�V6��Ɩ�C�F�fb6�V6���fƖFF���Wf�FV�6S�f�7W6VBfƖFF���76W3�gV��vFR�BƗfR66�VGV�W"�&W6V�BWf�FV�6R&V����V���7FGW3�&W6��fVB��6�FS�ƗfRFVƗfW'�Wf�FV�6R&V���2�V���&V�����rFWV�FV�6�W3�W�V7WFR66�VGV�W"�&�f�FW"�WFvR�&WG'��&V6��V�B��BGWƖ6FR�'V�G&���0�222��3#��v��WB�V"FV�WF���&VƖVB��G��֖2�B���ǒF&vWF��p���F��W7F��##b�r�RS��W&�6��Wu���&���6W'f�6S�v��WB�V"FW7G'V7F�fR7F���0��&�WFS�FV�WFUv��WE&�t7F��� ��ffV7FVBf��W3�����v��WB��V"�7F���2�G6�FW7G2�v��WB����W��7F����&�V�F&�W2�FW7B�G6 ��&��S�f֖ǒ��vW"�"WF�V�F�6FVB��W6V���B�V�&W"��f����rv��WBFV�WF�����66V�&���G��֖2F&�R��R�B�B���ǒFV�WFR&VƖVB��$�2��7FVB�bW�Ɩ6�Fǒ6��7G&����rF�R7F�fRf֖ǐ��6WfW&�G�� ���V�6���7C��Ɩ7�G&�gB6�V�BW&֗B7&�72�f֖ǒFV�WF����bv��WBFF��&��B6W6S�F�R7F���W6VBg&�҆��WB�F&�R��B�֗GFVBf֖Ǖ��Fg&��F�RFV�WFR&VF�6FP��&W6��WF����W�Ɩ6�B7W�'FVB�F&�R'&�6�W2��r��6�VFRf֖Ǖ��B�7G��7F�fR�f֖ǔ�F�$�2&V���2FVfV�6R��FWF���7W&6R��7C���66�V�6��vS�7G&V�wF�V�2W��7F��rf֖ǒ�66�VBv��WBF&�W2�B$�2�Ɩ6�W0��FW7G2'V��FW7G2�v��WB����W��7F����&�V�F&�W2�FW7B�G6�FW7G2�FV��B֗6��F����&�2�FW7B�G6�FW7G2�&��R�7W&f6R�FW7B�G6�FW7G2�&��R�FV�6�G��FW7B�G6�#"f�7W6VBFW7G2��G�V6�V6��Ɩ�C�F�fb6�V6���fƖFF���Wf�FV�6S�f�7W6VBfƖFF����BgV����6�vFR73�ƗfR7&�72�f֖ǒ�$�2�6��7W'&V�7�Wf�FV�6R&V���2�V���7FGW3�&W6��fVB��6�FS�ƗfRv��WBWF��&��F���Wf�FV�6R&V���2�V���&V�����rFWV�FV�6�W3�W�V7WFRWF�V�F�6FVBGv��f֖ǒv��WBFV�WF����B&��R�6��7W'&V�7�G&���0��222��3#����&�&F��r&�f�6�����r6���v�VFvVB��6���WFR7FFRw&�FW0���F��W7F��##b�r�RS��W&�6��Wu���&���6W'f�6S�&�f��R��&�&F��r�B6��F�&�ƗG�f�'7B�f֖ǒ&�f�6�����p��&�WFS�6���WFU&�f��T��&�&F��t7F����V�7W&T7F�fTf֖ǖ��B&�FV7FVB�vR��&�&F��rf��&6���ffV7FVBf��W3����&�&F��r�7F���2�G6�Ɩ"�6W'fW"�V�7W&R�f֖ǒ�G6�FW7G2���&�&F��r�f��W&R�6fWG��FW7B�G6 ��&��S��Wr66�V�B�v�W"�W��7F��r�V�F��f֖ǒW6W"�f֖ǒ��vW"��Bf�'7B���v��&�f�6�����rv�&�W ��66V�&����V�&W'6���&VfW&V�6R&VG2�"7V'67&�F����7F�fR�f֖ǒw&�FW2f��VBv���R��&�&F��r&WGW&�VB7V66W72��"6���"WFFRF�V6�VBWfW'�f֖ǒ�V�&W'6�� ��6WfW&�G�� ���V�6���7C���&�&F��r6�V�B6���WFRv�F��WBfƖBFV��B�7V'67&�F���7FFR�"�WFFR��F�W"f֖Ǟ(	�2T�FF��&��B6W6S�6V6��F'�7W&6R&W7V�BW'&�'2vW&R�v��&VB�BF�R�V�&W"6���"WFFR�6�VBf֖ǒ66�P��&W6��WF����&WV�&VB&VG2�Bw&�FW2��rf��6��6VB�6��F�&�ƗG�&�f�6�����r&W�'G2f�6R��7V'67&�F����7F�fR�f֖ǒf��W&W2��B6���"WFFW2F&vWBF�R&W6��fVBf֖ǒ��ǐ��7W&6R��7C���66�V�6��vS�&�FV7G2W��7F��rf֖Ǖ��V�&W'2�W6W%�&VfW&V�6W2�7V'67&�F���2�f֖ƖW2&�V�F&�W0��FW7G2'V��FW7G2���&�&F��r�f��W&R�6fWG��FW7B�G6�FW7G2���&�&F��r֖FV��FV�7��FW7B�G6�FW7G2�V�7W&R�f֖ǒ�6��7W'&V�7��FW7B�G6�FW7G2�WF��6��FW�B֖�FVw&�G��FW7B�G6�f�7W6VBFW7G2��G�V6�V6��Ɩ�C�F�fb6�V6���fƖFF���Wf�FV�6S�f�7W6VBfƖFF����BgV����6�vFR73�ƗfR��&�&F��r�F�W"���f�FR��B7&�72�FV��B$�2Wf�FV�6R&V���2�V���7FGW3�&W6��fVB��6�FS�ƗfR��&�&F��r�FW����V�BWf�FV�6R&V���2�V���&V�����rFWV�FV�6�W3�ǒ�BfW&�g�֖w&F���2#�#"�F�V�W�V7WFRf�'7B���v�����f�FR�F�W"��BGv��FV��BG&���0��222��3#r���6���WFRf֖ǒ6��FW�B6�V�B&R֗66�76�f�VB2��&�&F��p���F��W7F��##b�r�RC�S�W&�6��Wu���&���6W'f�6S�WF�V�F�6FVBW6W"6��FW�B�FV��B�V�&W'6��&W6��WF�����Bf�'7B�f֖ǒ&�f�6�����p��&�WFS�Ɩ"�7W&6R�WF��G6�&�FV7FVBvW2��B��&�&F��rf��&6���ffV7FVBf��W3�Ɩ"�7W&6R�WF��G6�FW7G2�WF��6��FW�B֖�FVw&�G��FW7B�G6 ��&��S�WF�V�F�6FVBW6W"v�F��V�&W'6��2�f֖ǒ��vW"��Bf�'7B���v��&�f�6�����rv�&�W ��66V�&����7F�fR�V�&W'6��6�V�B��B&R����VBF��G2f֖ǒ&�r�'WB6��FW�B&W6��WF���&WGW&�VBF�R��&�&F��r7FFP��6WfW&�G�� ���V�6���7C�'F��FV��B�6��FW�B&VB6�V�B7&VFR6V6��Bf֖ǒ�"֗7&�WFRF�RW6W"��7FVB�bf�Ɩ�r6fVǐ��&��B6W6S�֗76��rf֖ǒ����2vW&R6��V�Fǒf��FW&VB&Vf�&RF�R�VVG4f֖ǖ'&�6���&W6��WF������6���WFRf֖ǒ����2�B�V�&W'6�����w2��r&WGW&�&WG'�&�R6��FW�B�V�f��&�Rf��W&P��7W&6R��7C���66�V�6��vS�&�FV7G2W��7F��rf֖Ǖ��V�&W'2�f֖ƖW2�W6W%�&VfW&V�6W2&VG2�B&�f�6�����r6��0��FW7G2'V��FW7G2�WF��6��FW�B֖�FVw&�G��FW7B�G6�FW7G2�F֖��WF��&�V�F'��FW7B�G6�FW7G2�FV��B֗6��F����&�2�FW7B�G6�FW7G2�V�7W&R�f֖ǒ�6��7W'&V�7��FW7B�G6��f�7W6VBFW7G2��G�V6�V6��Ɩ�C�F�fb6�V6���fƖFF���Wf�FV�6S�f�7W6VBfƖFF����BgV����6�vFR73�ƗfRWF�F֖��$�2�&��R�'&�w6W"Wf�FV�6R&V���2�V���7FGW3�&W6��fVB��6�FS�ƗfRFV��B֗6��F���Wf�FV�6R&V���2�V���&V�����rFWV�FV�6�W3�ǒ#�#"�BW�V7WFRWF�V�F�6FVBGv��FV��B�Bf�'7B���v��G&���0��222��3#b�66�VGV�VB��FVw&F���26���v�VFvVB6V6��F'�W'6�7FV�6Rf��W&W0���F��W7F��##b�r�RC�C"�W&�6��Wu���&���6W'f�6S�wV&F���V&���r��WGv�&�vw&VvF����V7F���2�&�f�FW"7��2��B6�V�F"fVVB7��0��&�WFS����7&���wV&F����V&���v����7&����WGv�&��vw&VvFV����7&���6��6R�V7F���6����7&���&�f�FW"�7��6����7&���6�V�F"�fVVG6 ��ffV7FVBf��W3����7&���wV&F����V&���r�&�WFR�G6����7&����WGv�&��vw&VvFR�&�WFR�G6�Ɩ"��WGv�&��vw&VvFR�6W'fW"�G6����7&���6��6R�V7F���2�&�WFR�G6����7&���&�f�FW"�7��2�&�WFR�G6�Ɩ"�6W'fW"�6�V�F"�fVVG2�G6�FW7G2�7&���&V6�fW'��&�V�F&�W2�FW7B�G6 ��&��S�f֖ǒ�V�&W"��WGv�&��6��6V�F��r��W6V���B�V7F���'F�6��B�6���V7FVB�&�f�FW"W6W"�6�V�F"7V'67&�&W"��B66�VGV�VB7&��v�&�W ��66V�&���6V6��F'�&VG2�"w&�FW2f��VBgFW"&��'�&F6�&VG2v���RF�R��"&WGW&�VB7V66W72�"V&Ɨ6�VB��6���WFR7FFP��6WfW&�G�����V�6���7C��V&���r�vw&VvFR&�f7��V7F�����F�f�6F���2�7��2�'6W'f&�ƗG���"6�V�F"7FFR6�V�B&R��6���WFRv�F��WB&WG'�6�v����&��B6W6S�7W&6R&W7V�BW'&�'2vW&RF�66&FVB��6�V�W�6�W&6RVW&�W2�6��G&�'WF���'V���r���F�f�6F���2�VF�B��w2�WfV�BW6W'G2��BfVVB7FGW2w&�FW0��&W6��WF����&WV�&VB&VG2�Bw&�FW2&R6�V6�VC�7&��W'&�'2&R6��F��VB�B&WGW&�S"����6���WFR66�VGV�VBv�&��fVVB7��2f��2v�V�WfV�B�"7FGW2W'6�7FV�6Rf��0��7W&6R��7C���66�V�6��vS�W��7F��r6��6V�B�vw&VvFR��&�WG�6R�7��2��B6�V�F"66�W2&V���V�6��vV@��FW7G2'V��FW7G2�7&���&V6�fW'��&�V�F&�W2�FW7B�G6�FW7G2�7&���&F6��f��W&R�7FGW2�FW7B�G6�FW7G2�7&���&�f�FW"�7��2�FW7B�G6�FW7G2�7&���WF��FW7B�G6�FW7G2��&�WG�6R�V7F����6V7W&�G��FW7B�G6�rf�7W6VBFW7G2��G�V6�V6��Ɩ�C�F�fb6�V6���fƖFF���Wf�FV�6S�f�7W6VBfƖFF����BgV����6�vFR73�ƗfR66�VGV�W"�&�f�FW"�&�f7��$�2Wf�FV�6R&V���2�V���7FGW3�&W6��fVB��6�FS�ƗfR66�VGV�VB��FVw&F���Wf�FV�6R&V���2�V���&V�����rFWV�FV�6�W3�W�V7WFR66�VGV�W"�&�f�FW"�WFvR�&WG'��GWƖ6FR�'V��6��6V�B�&�f7���BƗfR7W&6RG&���0��222��3#R�&WGW&��B��FV�&Vg&W6�7&��26���v�VFvVBW'6�7FV�6Rf��W&W0���F��W7F��##b�r�RC�3R�W&�6��Wu���&���6W'f�6S��&�WG�6R&WGW&�&V֖�FW'2�B��W6V���B��FV�&Vg&W6���&�WFS����7&���&WGW&��&V֖�FW'6����7&�����FV��&Vg&W6� ��ffV7FVBf��W3����7&���&WGW&��&V֖�FW'2�&�WFR�G6����7&�����FV��&Vg&W6��&�WFR�G6�FW7G2�7&���&WGW&��&V֖�FW'2�&�V�F'��FW7B�G6 ��&��S�f֖ǒ�V�&W'2v�F��r��&WGW&�2���W6V���B�V�&W'2&Vǖ��r����FV�&��V7F���2��B66�VGV�VB7&��v�&�W'0��66V�&���6V6��F'�Ɨ7F��r���F�f�6F�����&FW"�7F��F�'G��7FFR��"F�'G��f�rf��W&W2vW&R�v��&VBgFW"&��'�&VG27V66VVFV@��6WfW&�G�����V�6���7C�&V֖�FW'26�V�B&WVB�"F�6V"��B��FV�&Vg&W6�6�V�B&W�'B7V66W72v���R7F�Rv�&�&V���VBVWVV@��&��B6W6S�7W&6R&W7V�BW'&�'2g&��6V6��F'�&VG2�Bw&�FW2vW&RF�66&FV@��&W6��WF����&WV�&VB&VG2�Bw&�FW2&R6�V6�VC�f��VB&V֖�FW"�FV�2�BF�'G��7FFRW'6�7FV�6R��r&�GV6R&WG'�&�R����7V66W72&W7��6W0��7W&6R��7C���66�V�6��vS�W��7F��r�&�WG�6R�B��FV��F�'G�66�W2&V���V�6��vV@��FW7G2'V��FW7G2�7&���&WGW&��&V֖�FW'2�&�V�F'��FW7B�G6�FW7G2�7&���&F6��f��W&R�7FGW2�FW7B�G6�FW7G2�7&���WF��FW7B�G6�f�7W6VBFW7G2��G�V6�V6��Ɩ�C�F�fb6�V6���fƖFF���Wf�FV�6S�f�7W6VBfƖFF����BgV����6�vFR73�ƗfR66�VGV�W"�&�f�FW"�$�2Wf�FV�6R&V���2�V���7FGW3�&W6��fVB��6�FS�ƗfR66�VGV�VBFVƗfW'�Wf�FV�6R&V���2�V���&V�����rFWV�FV�6�W3�W�V7WFR66�VGV�W"�GWƖ6FR�'V��&�f�FW"�WFvR�&WG'���BƗfR7W&6RG&���0��222��3#B���W&�W�&V6�fW'�6���v�VFvVBf��VB&�F���V�B7vVW0���F��W7F��##b�r�RC�3�W&�6��Wu���&���6W'f�6S�&�F��VB��&�&F��r�BFV����VB&V6�fW'�7&����&�WFS����7&�����W&�W��&V6�fW'� ��ffV7FVBf��W3����7&�����W&�W��&V6�fW'��&�WFR�G6�FW7G2���W&�W��&V6�fW'��7&���&�V�F'��FW7B�G6 ��&��S�&�F��VBW6W"�FV���VB��&�WF��r�W&F�"��B66�VGV�VB7&��v�&�W ��66V�&�����&�&F��r�5$��&�f��R��"WF��F���f��W&W2vW&R��vvVB'WBF�RV�G���B7F���&WGW&�VB7V66W72v�F�'F��6�V�G0��6WfW&�G�����V�6���7C�f����r�Wv�&�f��w26�V�B&R6��V�Fǒ6��VBv�F��WB��W&F����&WG'�6�v����&��B6W6S�7vVW�&�f��R�WF��F���f��W&W2vW&R��B6�V�FVB��F�R&W7��6R7FGW0��&W6��WF����&WV�&VB&VG2��rf��F�R7vVW�W"�&V6�&Bf��W&W2��7&V�V�Bf��VF��BF�RV�G���B&WGW&�2S"v�V���v�&�f��0��7W&6R��7C���66�V�6��vS�W��7F��r��&�&F��r�&�f��R�5$�66�W2&V���V�6��vV@��FW7G2'V��FW7G2���W&�W��&V6�fW'��7&���&�V�F'��FW7B�G6�FW7G2�7&���WF��FW7B�G6�bf�7W6VBFW7G2��G�V6�V6��Ɩ�C�F�fb6�V6���fƖFF���Wf�FV�6S�f�7W6VBfƖFF����BF�RgV����6�vFR73�ƗfR66�VGV�W"�&�f�FW"Wf�FV�6R&V���2�V���7FGW3�&W6��fVB��6�FS�ƗfRWF��F���Wf�FV�6R&V���2�V���&V�����rFWV�FV�6�W3�W�V7WFR66�VGV�W"�&�f�FW"�WFvR�&WG'��GWƖ6FR�'V���B&V6��V�BG&���0
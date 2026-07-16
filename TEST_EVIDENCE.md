# Test Evidence

Audit date: 2026-07-15

## Latest Local Evidence - Command Center Read Boundaries

- Focused Command Center boundary suite: 1 file, 1 assertion passed.
- Full `npm.cmd exec vitest run`: 510 test files, 3,270 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- Clean `npm.cmd run build`: passed and generated 250 routes; known webpack cache serialization and Supabase Edge-runtime compatibility warnings remain.
- `git diff --check`: passed before commit.
- Command Center now fails visibly when a family source or Operating Index read fails instead of computing a partial readiness score.
- Live Auth Admin, Super Admin permission, RLS/role, browser, backup, and deployment evidence remain open.
- Source commit: `306aeb17`.

## Latest Local Evidence - Dashboard Briefing Snapshot Read Boundary

- Focused Briefing boundary suite: 1 file, 1 assertion passed.
- Full `npm.cmd exec vitest run`: 509 test files, 3,269 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- Clean `npm.cmd run build`: passed and generated 250 routes; known webpack cache serialization and Supabase Edge-runtime compatibility warnings remain.
- `git diff --check`: passed before commit.
- Dashboard Briefing now fails visibly when the persisted Operating Index snapshot cannot be read instead of silently omitting the recap.
- Live Auth Admin, Super Admin permission, RLS/role, browser, backup, and deployment evidence remain open.
- Source commit: `c56b870e`.

## Latest Local Evidence - Dashboard Activity Read Boundary

- Focused Activity page boundary suite: 1 file, 1 assertion passed.
- Full `npm.cmd exec vitest run`: 508 test files, 3,268 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- Clean `npm.cmd run build`: passed and generated 250 routes; known webpack cache serialization and Supabase Edge-runtime compatibility warnings remain.
- `git diff --check`: passed before commit.
- Dashboard Activity now fails visibly when any source or chore-title enrichment read fails instead of rendering an incomplete feed.
- Live Auth Admin, Super Admin permission, RLS/role, browser, backup, and deployment evidence remain open.
- Source commit: `463c5b60`.

## Latest Local Evidence - Dashboard Home Preference Read Boundary

- Focused Dashboard Home boundary suite: 1 file, 1 assertion passed.
- Full `npm.cmd exec vitest run`: 507 test files, 3,267 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- Clean `npm.cmd run build`: passed and generated 250 routes; known webpack cache serialization and Supabase Edge-runtime compatibility warnings remain.
- `git diff --check`: passed before commit.
- Dashboard Home now fails visibly when the saved default dashboard preference cannot be read instead of silently choosing the AI dashboard.
- Live Auth Admin, Super Admin permission, RLS/role, browser, backup, and deployment evidence remain open.
- Source commit: `49a5ec33`.

## Latest Local Evidence - Family Summary Read Boundaries

- Focused Family Summary boundary suite: 1 file, 1 assertion passed.
- Full `npm.cmd exec vitest run`: 506 test files, 3,266 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- Clean `npm.cmd run build`: passed and generated 250 routes; known webpack cache serialization and Supabase Edge-runtime compatibility warnings remain.
- `git diff --check`: passed before commit.
- Family Operations and Family Reports now fail visibly when shared signal reads fail instead of rendering healthy zero-valued summaries.
- Live Auth Admin, Super Admin permission, RLS/role, browser, backup, and deployment evidence remain open.
- Source commit: `dd3c2929`.

## Latest Local Evidence - Family Stress Read Boundaries

- Focused Family Stress boundary suite: 1 file, 1 assertion passed.
- Full `npm.cmd exec vitest run`: 505 test files, 3,265 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- Clean `npm.cmd run build`: passed and generated 250 routes; known webpack cache serialization and Supabase Edge-runtime compatibility warnings remain.
- `git diff --check`: passed before commit.
- Family Stress now fails visibly when signal, active-member, or logged-input reads cannot be read instead of presenting a healthy forecast or empty input history.
- Live Auth Admin, Super Admin permission, RLS/role, browser, backup, and deployment evidence remain open.
- Source commit: `c4c3cb5f`.

## Latest Local Evidence - Family Automation Read Boundaries

- Focused Family Automation boundary suite: 1 file, 1 assertion passed.
- Full `npm.cmd exec vitest run`: 504 test files, 3,264 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- Clean `npm.cmd run build`: passed and generated 250 routes; known webpack cache serialization and Supabase Edge-runtime compatibility warnings remain.
- `git diff --check`: passed before commit.
- Family Automation now fails visibly when rules or pending/recent automation-run feeds cannot be read instead of presenting healthy metrics, empty queues, or active CRUD controls.
- Live Auth Admin, Super Admin permission, RLS/role, browser, backup, and deployment evidence remain open.
- Source commit: `4a01fc5e`.

## Latest Local Evidence - Contact Timeline Read Boundaries

- Focused Contact Timeline boundary suite: 1 file, 1 assertion passed.
- Full `npm.cmd exec vitest run`: 503 test files, 3,263 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- Clean `npm.cmd run build`: passed and generated 250 routes; known webpack cache serialization and Supabase Edge-runtime compatibility warnings remain.
- `git diff --check`: passed before commit.
- Contact Timeline now fails visibly when the contact, interaction, or communication reads fail instead of presenting a missing contact or empty relationship history.
- Live Auth Admin, Super Admin permission, RLS/role, browser, backup, and deployment evidence remain open.
- Source commit: `ae763b67`.

## Latest Local Evidence - Autonomous Family Management Read Boundaries

- Focused Autonomous Family Management boundary suite: 1 file, 1 assertion passed.
- Full `npm.cmd exec vitest run`: 502 test files, 3,262 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- Clean `npm.cmd run build`: passed and generated 250 routes; known webpack cache serialization and Supabase Edge-runtime compatibility warnings remain.
- `git diff --check`: passed before commit.
- Autonomous Family Management now fails visibly when required family signals, recommendations, rules, or automation runs cannot be read instead of presenting healthy zero-valued monitoring and approval controls.
- Live Auth Admin, Super Admin permission, RLS/role, browser, backup, and deployment evidence remain open.
- Source commit: `f04895cd`.

## Latest Local Evidence - Family Assistant Read Boundaries

- Focused Family Assistant boundary suite: 1 file, 1 assertion passed.
- Full `npm.cmd test -- --run`: 501 test files, 3,261 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- Clean `npm.cmd run build`: passed and generated 250 routes; known webpack cache serialization and Supabase Edge-runtime compatibility warnings remain.
- `git diff --check`: passed before commit.
- Family Assistant now fails visibly when any required context or count read fails instead of deriving zero-valued briefings.
- Live Auth Admin, Super Admin permission, RLS/role, browser, backup, and deployment evidence remain open.
- Source commit: `d43b15c4`.

## Latest Local Evidence - Family Intelligence Read Boundary

- Focused Family Intelligence boundary suite: 1 file, 1 assertion passed.
- Full `npm.cmd test -- --run`: 500 test files, 3,260 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- Clean `npm.cmd run build`: passed and generated 250 routes; known webpack cache serialization and Supabase Edge-runtime compatibility warnings remain.
- `git diff --check`: passed before commit.
- Family Intelligence now fails visibly when `family_signals` cannot be read instead of presenting an empty intelligence screen.
- Live Auth Admin, Super Admin permission, RLS/role, browser, backup, and deployment evidence remain open.
- Source commit: `384acfbd`.

## Latest Local Evidence - Marketplace Deals Read Boundary

- Focused Deals boundary suite: 1 file, 1 assertion passed.
- Full `npm.cmd test -- --run`: 499 test files, 3,259 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- Clean `npm.cmd run build`: passed and generated 250 routes; known webpack cache serialization and Supabase Edge-runtime compatibility warnings remain.
- `git diff --check`: passed before commit.
- Deals now fails visibly when marketplace listings cannot be read instead of presenting a healthy empty deal feed.
- Live Auth Admin, Super Admin permission, RLS/role, browser, backup, and deployment evidence remain open.
- Source commit: `071bfd7c`.

## Latest Local Evidence - Marketplace Selling Read Boundaries

- Focused Selling boundary suite: 1 file, 1 assertion passed.
- Full `npm.cmd test -- --run`: 498 test files, 3,258 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- Clean `npm.cmd run build`: passed and generated 250 routes; known webpack cache serialization and Supabase Edge-runtime compatibility warnings remain.
- `git diff --check`: passed before commit.
- Selling now fails visibly when its listing or seller-signal reads fail instead of presenting zero seller activity.
- Live Auth Admin, Super Admin permission, RLS/role, browser, backup, and deployment evidence remain open.
- Source commit: `db158e01`.

## Latest Local Evidence - Marketplace Live Auctions Read Boundary

- Focused Live Auctions boundary suite: 1 file, 1 assertion passed.
- Full `npm.cmd test -- --run`: 497 test files, 3,257 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- Clean `npm.cmd run build`: passed and generated 250 routes; known webpack cache serialization and Supabase Edge-runtime compatibility warnings remain.
- `git diff --check`: passed before commit.
- Live Auctions now fails visibly when marketplace listings cannot be read instead of presenting a healthy empty board.
- Live Auth Admin, Super Admin permission, RLS/role, browser, backup, and deployment evidence remain open.
- Source commit: `f86dd8a2`.

## Latest Local Evidence - Referrals Read Boundaries

- Focused Referrals boundary suite: 1 file, 1 assertion passed.
- Full `npm.cmd test -- --run`: 496 test files, 3,256 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- Clean `npm.cmd run build`: passed and generated 250 routes; known webpack cache serialization and Supabase Edge-runtime compatibility warnings remain.
- `git diff --check`: passed before commit.
- Admin Referrals now fails visibly when either referral settings or activity cannot be read instead of showing defaults or no activity.
- Live Auth Admin, Super Admin permission, RLS/role, browser, backup, and deployment evidence remain open.
- Source commit: `2b06e789`.

## Latest Local Evidence - New Campaign Segment Read Boundary

- Focused New Campaign boundary suite: 1 file, 1 assertion passed.
- Full `npm.cmd test -- --run`: 495 test files, 3,255 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- Clean `npm.cmd run build`: passed and generated 250 routes; known webpack cache serialization and Supabase Edge-runtime compatibility warnings remain.
- `git diff --check`: passed before commit.
- New Campaign now fails visibly when `marketing_segments` cannot be read instead of allowing an unfiltered campaign by default.
- Live Auth Admin, Super Admin permission, RLS/role, browser, backup, and deployment evidence remain open.
- Source commit: `d600ad7c`.

## Latest Local Evidence - Social Providers Read Boundary

- Focused Social Providers boundary suite: 1 file, 1 assertion passed.
- Full `npm.cmd test -- --run`: 494 test files, 3,254 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- Clean `npm.cmd run build`: passed and generated 250 routes; known webpack cache serialization and Supabase Edge-runtime compatibility warnings remain.
- `git diff --check`: passed before commit.
- Social Providers now fails visibly when the `social_providers` catalog cannot be read instead of defaulting every provider to enabled.
- Live Auth Admin, Super Admin permission, RLS/role, browser, backup, and deployment evidence remain open.
- Source commit: `51423350`.

## Latest Local Evidence - Admin Settings Read Boundary

- Focused Admin Settings boundary suite: 1 file, 1 assertion passed.
- Full `npm.cmd test -- --run`: 493 test files, 3,253 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- Clean `npm.cmd run build`: passed and generated 250 routes; known webpack cache serialization and Supabase Edge-runtime compatibility warnings remain.
- `git diff --check`: passed before commit.
- Admin Settings now fails visibly when the `super_admins` count cannot be read instead of rendering zero access holders.
- Live Auth Admin, Super Ad�mv��$z{-���jםV�'V��F�76VB�BvV�W&FVB#S&�WFW3�W��7F��r����&��6���r66�R�BVFvR�'V�F��Rv&���w2&V������v�BF�fb��6�V6��76VB����F֖��fVVF&6��B�F֖����FVw&F���6��r&V�FW"&Vg&W6�&�RW'&�"7FFW2v�V�F�V�"7W&6R&VG2f����7FVB�b&W�'F��r�V�G�VWVR�"f�6R��B�6��f�wW&VB7FGW2���6�W&6R6��֗C��cF3ff��F�72�B6�W&6R&RV&Ɨ6�VB���&�v������B3F3fFfࠢ22�FW7B��6�Wf�FV�6R�F֖�7V'67&�F���&VBf��W&P������6�BW�V2f�FW7B'V�FW7G2�F֖��7V'67&�F���2�&VB�&�V�F'��FW7B�G6�f��R�f�7W6VBFW7B76VB������6�BFW7F�C#bf��W2�2��rFW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2������6�BVF�B���֗C�FWb��VF�B��WfV����FW&FV�76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW3�W��7F��r����&��6���r66�R�BVFvR�'V�F��Rv&���w2&V������v�BF�fb��6�V6��76VB����F֖��7V'67&�F���6��r&V�FW'2&Vg&W6�&�RW'&�"7FFRv�V�7V'67&�F����f֖ǒ��"&��Ɩ�r�7W7F��W"&VG2f����7FVB�b&W�'F��rV�G���F�F�2���6�W&6R6��֗C�s�&#c�F�72�B6�W&6R&RV&Ɨ6�VB���&�v������B#&F3sVࠢ22�FW7B��6�Wf�FV�6R�F֖�7G&�R&VBf��W&P������6�BW�V2f�FW7B'V�FW7G2�F֖��7G&�R�&VB�&�V�F'��FW7B�G6�f��R�"f�7W6VBFW7G276VB������6�BFW7F�C#rf��W2�2���FW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2������6�BVF�B���֗C�FWb��VF�B��WfV����FW&FV�76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW3�W��7F��r����&��6���r66�R�BVFvR�'V�F��Rv&���w2&V������v�BF�fb��6�V6��76VB����F֖��7G&�V��r&V�FW'2&Vg&W6�&�RW'&�"7FFRf�"fVGW&R�f�r�6��f�wW&F����f���6���F&�R��"vV&����&VBf��W&W2v���Rv��WB6��7V�W'2&WF���VFvW"f��&6����6�W&6R6��֗C�sC�CvF�F�72�B6�W&6R&RV&Ɨ6�VB���&�v������BS�#s3�&6ࠢ22�FW7B��6�Wf�FV�6R�F֖��&�WF��r&VBf��W&P������6�BW�V2f�FW7B'V�FW7G2�F֖���&�WF��r�&VB�&�V�F'��FW7B�G6�f��R�"f�7W6VBFW7G276VB������6�BFW7F�C#�f��W2�2�FW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2������6�BVF�B���֗C�FWb��VF�B��WfV����FW&FV�76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW3�W��7F��r����&��6���r66�R�BVFvR�'V�F��Rv&���w2&V������v�BF�fb��6�V6��76VB����F֖���&�WF��r�G6�B�F֖���&�WF��r�WF��F�����r&V�FW"&Vg&W6�&�RW'&�"7FFW2v�V�F�V�"&��'�7W&6R&VG2f����7FVB�b&W�'F��rV�G������rf�Ww2���6�W&6R6��֗C�S#CF�F�72�B6�W&6R&RV&Ɨ6�VB���&�v������BvFc#c#Vࠢ22�FW7B��6�Wf�FV�6R��&�WF��rF6�&�&B&VBf��W&P������6�BW�V2f�FW7B'V�FW7G2�F֖���&�WF��r�F6�&�&B�&VB�&�V�F'��FW7B�G6�f��R�2f�7W6VBFW7G276VB������6�BFW7F�C#�f��W2�2�BFW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2������6�BVF�B���֗C�FWb��VF�B��WfV����FW&FV�76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW3�W��7F��r����&��6���r66�R�BVFvR�'V�F��Rv&���w2&V������v�BF�fb��6�V6��76VB���F�R6�&VB7W7F��W"��FW"��rW��6W2&VBW'&�'2F�F�v��7F�2vW2v���R&W6W'f��r6��7V�W"f��&6���F֖���&�WF��v�B�F֖���&�WF��r��ǗF�76&V�FW"&WG'�7FFW2��7FVB�b�W&��f�VVB7W7F��W"�6��v��WG&�72���6�W&6R6��֗C�Ss#sc�&6�F�72�B6�W&6R&RV&Ɨ6�VB���&�v������B##sfc�C�ࠢ22�FW7B��6�Wf�FV�6R��&�WF��rF֖�&VB&�V�F&�W0������6�BW�V2f�FW7B'V�FW7G2�F֖���&�WF��r�6��FV�B�6��v�2�&VB�&�V�F'��FW7B�G2FW7G2�F֖���&�WF��r�76WG2��W76v��r�&VB�&�V�F'��FW7B�G2FW7G2�F֖���&�WF��r�7&��&VB�&�V�F'��FW7B�G2FW7G2�F֖���&�WF��r�6��G&�����R�&VB�&�V�F'��FW7B�G2FW7G2�F֖���&�WF��r�V&Ɨ6���r�&VB�&�V�F'��FW7B�G2FW7G2�F֖���&�WF��r�&Wv&G2�7W'fW�2�&VB�&�V�F'��FW7B�G6�bf��W2��f�7W6VBFW7G276VB������6�BFW7F�C3bf��W2�2�#�FW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2������6�BVF�B���֗C�FWb��VF�B��WfV�ֆ�v��76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW2���v�BF�fb��6�V6��76VB����&�WF��r6��FV�B�6��v��76WB&Wf�Wr��W76v��r�7W7F��W"��VB�5$��4T��T��6��G&�����R�W�W&��V�B�V&Ɨ6���r�ff�ƖFR�����G��&��6��7W'fW�vW2��r7W&f6R7W&6R�7F�&vR&VBf��W&W2��7FVB�b&V�FW&��rV�G��"�W&��f�VVB�W&F����7FFR���6�W&6R6�V6����B&Vf�&Rf���F�72&Vg&W6��cs�Sf��W&vVB6��7W'&V�B���6��vW2��F�72�B6�W&6R&RV&Ɨ6�VB���&�v���6�FW��v�&�B�6�72�&�GV7F���BcFfSs�Fࠢ22�FW7B��6�Wf�FV�6R�WF��BV&Ɩ2�&�V�F&�W0���f�7W6VBWF�6��FW�B��WF�6��&6��F֖�6�V���֖FF�Wv&RV&Ɩ2���B7&��WF��&��F���6��G&7G276VB�2FW7G27&�72R7V�FW2�������6�BFW7F�C3�f��W2�2�CFW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2������6�BVF�B���֗C�FWb��VF�B��WfV�ֆ�v��76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW3�W��7F��r7W&6RVFvR�'V�F��R6��F�&�ƗG�v&���r&V���2���v�BF�fb��6�V6��76VB���6�&VBWF���r��w2&�f�FW"����vƗ7Bf��W&W2�BG&VG2WF�V�F�6FVB6��FW�Bf��W&W22V�f��&�S��WF�6��&6��V�&W'6��f��W&W2�����vW"&�WFR��F���&�&F��s�F�RF֖�6�V��W��6W2&�f��R���f�FR���F�f�6F���&VBv&���w3�֖FF�Wv&R&V6�W2��FV�FVBV&Ɩ2�B�6���R�WF�V�F�6FVB&�WFRwV&G2���6�W&6R6��֗C�&C�#6��W&vVB6�W&6R6�V6����C�VC�s3�ff�VF�BWf�FV�6R�2V&Ɨ6�VBBF�R7W'&V�B'&�6�F�ࠢ22�FW7B��6�Wf�FV�6R��&�WG�6R�fW'f�Wr&VBf��W&P���f�7W6VB�&�WG�6R���R�&W�'G2��B6���V��G�7V�FW3�2f��W2��FW7G276VB������6�BFW7F�CCf��W2�2�C2FW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2������6�BVF�B���֗C�FWb��VF�B��WfV�ֆ�v��76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW3�W��7F��r7W&6RVFvR�'V�F��R6��F�&�ƗG�v&���r&V���2���v�BF�fb��6�V6��76VB�����&�WG�6V��r7W&f6W2�&V�VB&VBf��W&W2f�"����FWV�FV�BF�66�fW'��7F�f�G��7&VF�"��B6���V7F���6�W&6W2&F�W"F��&V�FW&��r�V�G��V�F��&�&B���6�W&6R6��֗C�#3&Svf�F�72&Vg&W6��BV&Ɩ6F���&R��&�w&W72ࠢ22�FW7B��6�Wf�FV�6R��&�WG�6RƗ7F��rFWF��&VBf��W&P���f�7W6VB�&�WG�6R���R��FV��&W�'G2��B6���V��G�7V�FW3�Bf��W2�#FW7G276VB������6�BFW7F�CCf��W2�2�CRFW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2������6�BVF�B���֗C�FWb��VF�B��WfV�ֆ�v��76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW3�W��7F��r7W&6RVFvR�'V�F��R6��F�&�ƗG�v&���r&V���2���v�BF�fb��6�V6��76VB����&�WG�6RƗ7F��rFWF����rF�7F��wV�6�W2f��VB&VG2g&��֗76��r&�w2�B7W&f6W2FWV�FV�B&�B�G'W7B��ffW"��&FW"�7F�&R�&�6Rֆ�7F�'��6��&&�R��B�Vv�F�F���f��W&W2���6�W&6R6��֗C�Ccc�V6C��F�72&Vg&W6��BV&Ɩ6F���&R��&�w&W72ࠢ22�FW7B��6�Wf�FV�6R��&�WG�6R6���V��G�&VBf��W&P���f�7W6VB6���V��G�6�&6�W2&VB�&�V�F'��BF����7V�FW3�"f��W2�rFW7G276VB������6�BFW7F�CC"f��W2�2�CrFW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2������6�BVF�B���֗C�FWb��VF�B��WfV�ֆ�v��76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW3�W��7F��r7W&6RVFvR�'V�F��R6��F�&�ƗG�v&���r&V���2���v�BF�fb��6�V6��76VB���6���V��G�6�&6�W2��rF�7F��wV�6�W2֗76��r֖w&F���2g&��G&�6�V�B6�&6�R��V�&W"�6�&R�Ɨ7F��rf��W&W2�B7W&f6W2F�RffV7FVB6�W&6R�&V�2v�F��WB��F��rW6&�RFF���6�W&6R6��֗C�SvS�s6C6�F�72&Vg&W6��BV&Ɩ6F���&R��&�w&W72ࠢ22�FW7B��6�Wf�FV�6R��&�WG�6R�&FW'2&VBf��W&P���f�7W6VB�&�WG�6R�&FW'2&VB�&�V�F'�7V�FS�f��R�"FW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2������6�BVF�B���֗C�FWb��VF�B��WfV�ֆ�v��76VBv�F�gV��W&&�ƗF�W2���v�BF�fb��6�V6��76VB�����&�WG�6R��&FW'6��rf��26�V&ǒ��F�R&��'��&FW"&VB�B7W&f6W2�&V�VBv&���w2f�"fVR6WGF��w2�Ɨ7F��rF�F�W2�f֖ǒ�V�&W'2�&Wf�Wr��7F�'���B��F�fb6��&F��F���f��W&W2���6�W&6R6��֗C�cS&Vc&�'&�6��B���V&Ɩ6F���fW&�f�VBࠢ22�FW7B��6�Wf�FV�6R��&�WG�6R�W'G2&VBf��W&P���f�7W6VB�&�WG�6R�W'G2&VB�&�V�F'�7V�FS�f��R�"FW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2���v�BF�fb��6�V6��76VB�����&�WG�6R��W'G6��rf��26�V&ǒv�V�6fVB6V&6�W26���B&R&VB�B7W&f6W2�F6���r�Ɨ7F��r�B6fVB�7FFRf��W&W2��7FVB�b&W6V�F��r�V�F��V�G��W'Bf�Wr���gV�����6�BFW7F�CCBf��W2�2�SFW7G276VB������6�BVF�B���֗C�FWb��VF�B��WfV�ֆ�v��76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW3�W��7F��r7W&6RVFvR�'V�F��Rv&���r&V���2v�V�V֗GFVB���6�W&6R6��֗C�Fcf#c�f�'&�6��B���V&Ɩ6F���fW&�f�VBࠢ22�FW7B��6�Wf�FV�6R��&�WG�6R7&VF�'2&VBf��W&P���f�7W6VB�&�WG�6R7&VF�'2&VB�&�V�F'�7V�FS�f��R�"FW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2���v�BF�fb��6�V6��76VB�����&�WG�6R�7&VF�'6��rf��26�V&ǒv�V�7F�&Vg&��G26���B&R&VB�B7W&f6W2f����vW"�&Wf�Wr��B�V��Ɨ7F��rf��W&W2��7FVB�b&W6V�F��r���6���WFR7&VF�"&涖�r���gV�����6�BFW7F�CCRf��W2�2�S2FW7G276VB������6�BVF�B���֗C�FWb��VF�B��WfV�ֆ�v��76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW3�W��7F��r7W&6RVFvR�'V�F��Rv&���r&V���2v�V�V֗GFVB���6�W&6R6��֗C�F6&S�S���'&�6�V&Ɩ6F���fW&�f�VC�&V��FR����W&vR�2VC3C##6V�F��rf���W6�ࠢ22�FW7B��6�Wf�FV�6R��&�WG�6Rf����v��r�B6���V7F���2&VBf��W&W0���f�7W6VBf����v��r�B6���V7F���2&VB�&�V�F'�7V�FW3�"f��W2�BFW7G276VB���gV�����6�BFW7F�CCrf��W2�2�SrFW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2������6�BVF�B���֗C�FWb��VF�B��WfV�ֆ�v��76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW2���v�BF�fb��6�V6��76VB���f����v��r��rF�7F��wV�6�W2f��VBf����r&VBg&���V�G�fVVB�B7W&f6W26fVB�7F�&R��BƗ7F��rf��W&W3�6���V7F���2F�W2F�R6�Rf�"6���V7F���2��FV�2��B6���V7F���Ɨ7F��w2��F�&V7F�'��BFWF��f�Ww2���6�W&6R6��֗C�&c�CF636�'&�6��B���V&Ɩ6F���fW&�f�VBࠢ22�FW7B��6�Wf�FV�6R�v��WB&VBf��W&P���f�7W6VBv��WB&VB�&�V�F'�7V�FS�f��R�"FW7G276VB���gV�����6�BFW7F�CC�f��W2�2�S�FW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2������6�BVF�B���֗C�FWb��VF�B��WfV�ֆ�v��76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW2���v�BF�fb��6�V6��76VB���v��WB6V�B���W��7F�f�G��G&V7W'��v��2����v�6R��B6&G2��rf��6�V&ǒ��&��'�v��WB&VG2�B7W&f6RFWV�FV�B�VFvW"��FV�F�G��6��f�wW&F����6���V7FVB�66�V�B�7��2��B�77VVB�6&Bf��W&W2��7FVB�b6��V�FǒFW&�f��r�W&��"��6���WFRf���6��f�Ww2���6�W&6R6��֗C�#�S�VC�'&�6��B���V&Ɩ6F���fW&�f�VBࠢ22&�w&W726�6��B�##b�r�R3�3����fW&��FV6�6���������t������fW&�f�VB6���WF��������V���7W'&V�B6W'f�6S�v��WB����W���fV�V�B��B6���V7FVB�6&B&VB&�V�F&�W2���6���WFVBF��2��FW'fâ6V�B���W��7F�f�G��G&V7W'��v��2����v�6R��B6&G2��rF�7F��wV�6�&��'�f��W&W2g&����7F�fR�V�G�7FFR�B7W&f6RFWV�FV�B&VB�7��2f��W&W2���FW7G2FFVB�WFFVC�FW7G2�v��WB�&VB�&�V�F'��FW7B�G6�"f�7W6VBFW7G2����gV��fW&�f�6F����CC�FW7Bf��W2�2�S�FW7G3�G�V6�V6��Ɩ�C�FWV�FV�7�VF�B�gV��W&&�ƗF�W2��&�GV7F���'V��B�#S&�WFW2��F�fb6�V6���76VB���7W&6R7FGW3�W��7F��r66�V�&�&W2&V���w&VV��&V��FR֖w&F���Ɩ6F����BƗfRv��WB�$�2�&��R�6��7W'&V�7�Wf�FV�6R&V���V�fW&�f�VB���FW����V�B7FGW3�6�W&6RV&Ɩ6F���f����w2F��26�6��C�ƗfRWF�F֖��EES�B��6�F�6�W"�7W&6RV�f��&�ƗG�&V����V�&��6�W'2����FW7BfW&�f�VB6��֗C�#CCcv3sf&Vf�&RF�Rv��WB6�W&6R��7&V�V�B����W�C�V&Ɨ6�F�Rv��WB��7&V�V�B�F�V�6��F��VRF�R&V�����rv��WB&�WFW2�B���W��vV&�����7&����FVw&F���VF�B��22�FW7B��6�Wf�FV�6R�&��Ɩ�r7FFR&VB&�V�F&�W0���f�7W6VB&��Ɩ�r&VB�&�V�F'�7V�FS�f��R�"FW7G276VB���gV�����6�BFW7B����'V��CC�f��W2�2�cFW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2������6�BVF�B���֗C�FWb��VF�B��WfV�ֆ�v��76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW3�W��7F��r7W&6RVFvR�'V�F��R6��F�&�ƗG�v&���r&V���2v�V�V֗GFVB���v�BF�fb��6�V6��76VB���6�V6��WB�6��vR����6�6V���B�'F���rf��6��6VB��&WV�&VB&��Ɩ�r7FFR�&VBW'&�'3�&��Ɩ�r�7W7F��W"w&�FRf��W&W2&WGW&�S2�BG&6���r��F�֗7F�2�7��2f��W&W2&R��vvVB���6�W&6R6��vW2&R7W'&V�FǒV�6��֗GFVBV�F��rV&Ɩ6F����ƗfR7G&�RFW7B���FR�vV&������FV��FV�7���WFvR�&VgV�B��B&V��FR7W&6RWf�FV�6R&V����V��
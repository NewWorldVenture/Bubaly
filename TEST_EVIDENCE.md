# Test Evidence

Audit date: 2026-07-15

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
- Live Auth Admin, Super Admin permission, RLS/role, browser, backup, and deployment evidence remain open.
- Source commit: `0f91564a`.

## Latest Local Evidence - Admin Management Read Boundary

- Focused Admin Management boundary suite: 1 file, 1 assertion passed.
- Full `npm.cmd test -- --run`: 492 test files, 3,252 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with no ESLint warnings or errors; only the known Next.js `next lint` deprecation notice remains.
- Clean `npm.cmd run build`: passed and generated 250 routes; known webpack cache serialization and Supabase Edge-runtime compatibility warnings remain.
- `git diff --check`: passed before commit.
- Admin Management now fails visibly when `admin_users` cannot be read instead of rendering zero administrators.
- Live Auth Admin, Super Admin permission, RLS/r�_8��$z{-���jםV�'V��F�76VB�BvV�W&FVB#S&�WFW3�W��7F��r����&��6���r66�R�BVFvR�'V�F��Rv&���w2&V������v�BF�fb��6�V6��76VB����F֖��fVVF&6��B�F֖����FVw&F���6��r&V�FW"&Vg&W6�&�RW'&�"7FFW2v�V�F�V�"7W&6R&VG2f����7FVB�b&W�'F��r�V�G�VWVR�"f�6R��B�6��f�wW&VB7FGW2���6�W&6R6��֗C��cF3ff��F�72�B6�W&6R&RV&Ɨ6�VB���&�v������B3F3fFfࠢ22�FW7B��6�Wf�FV�6R�F֖�7V'67&�F���&VBf��W&P������6�BW�V2f�FW7B'V�FW7G2�F֖��7V'67&�F���2�&VB�&�V�F'��FW7B�G6�f��R�f�7W6VBFW7B76VB������6�BFW7F�C#bf��W2�2��rFW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2������6�BVF�B���֗C�FWb��VF�B��WfV����FW&FV�76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW3�W��7F��r����&��6���r66�R�BVFvR�'V�F��Rv&���w2&V������v�BF�fb��6�V6��76VB����F֖��7V'67&�F���6��r&V�FW'2&Vg&W6�&�RW'&�"7FFRv�V�7V'67&�F����f֖ǒ��"&��Ɩ�r�7W7F��W"&VG2f����7FVB�b&W�'F��rV�G���F�F�2���6�W&6R6��֗C�s�&#c�F�72�B6�W&6R&RV&Ɨ6�VB���&�v������B#&F3sVࠢ22�FW7B��6�Wf�FV�6R�F֖�7G&�R&VBf��W&P������6�BW�V2f�FW7B'V�FW7G2�F֖��7G&�R�&VB�&�V�F'��FW7B�G6�f��R�"f�7W6VBFW7G276VB������6�BFW7F�C#rf��W2�2���FW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2������6�BVF�B���֗C�FWb��VF�B��WfV����FW&FV�76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW3�W��7F��r����&��6���r66�R�BVFvR�'V�F��Rv&���w2&V������v�BF�fb��6�V6��76VB����F֖��7G&�V��r&V�FW'2&Vg&W6�&�RW'&�"7FFRf�"fVGW&R�f�r�6��f�wW&F����f���6���F&�R��"vV&����&VBf��W&W2v���Rv��WB6��7V�W'2&WF���VFvW"f��&6����6�W&6R6��֗C�sC�CvF�F�72�B6�W&6R&RV&Ɨ6�VB���&�v������BS�#s3�&6ࠢ22�FW7B��6�Wf�FV�6R�F֖��&�WF��r&VBf��W&P������6�BW�V2f�FW7B'V�FW7G2�F֖���&�WF��r�&VB�&�V�F'��FW7B�G6�f��R�"f�7W6VBFW7G276VB������6�BFW7F�C#�f��W2�2�FW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2������6�BVF�B���֗C�FWb��VF�B��WfV����FW&FV�76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW3�W��7F��r����&��6���r66�R�BVFvR�'V�F��Rv&���w2&V������v�BF�fb��6�V6��76VB����F֖���&�WF��r�G6�B�F֖���&�WF��r�WF��F�����r&V�FW"&Vg&W6�&�RW'&�"7FFW2v�V�F�V�"&��'�7W&6R&VG2f����7FVB�b&W�'F��rV�G������rf�Ww2���6�W&6R6��֗C�S#CF�F�72�B6�W&6R&RV&Ɨ6�VB���&�v������BvFc#c#Vࠢ22�FW7B��6�Wf�FV�6R��&�WF��rF6�&�&B&VBf��W&P������6�BW�V2f�FW7B'V�FW7G2�F֖���&�WF��r�F6�&�&B�&VB�&�V�F'��FW7B�G6�f��R�2f�7W6VBFW7G276VB������6�BFW7F�C#�f��W2�2�BFW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2������6�BVF�B���֗C�FWb��VF�B��WfV����FW&FV�76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW3�W��7F��r����&��6���r66�R�BVFvR�'V�F��Rv&���w2&V������v�BF�fb��6�V6��76VB���F�R6�&VB7W7F��W"��FW"��rW��6W2&VBW'&�'2F�F�v��7F�2vW2v���R&W6W'f��r6��7V�W"f��&6���F֖���&�WF��v�B�F֖���&�WF��r��ǗF�76&V�FW"&WG'�7FFW2��7FVB�b�W&��f�VVB7W7F��W"�6��v��WG&�72���6�W&6R6��֗C�Ss#sc�&6�F�72�B6�W&6R&RV&Ɨ6�VB���&�v������B##sfc�C�ࠢ22�FW7B��6�Wf�FV�6R��&�WF��rF֖�&VB&�V�F&�W0������6�BW�V2f�FW7B'V�FW7G2�F֖���&�WF��r�6��FV�B�6��v�2�&VB�&�V�F'��FW7B�G2FW7G2�F֖���&�WF��r�76WG2��W76v��r�&VB�&�V�F'��FW7B�G2FW7G2�F֖���&�WF��r�7&��&VB�&�V�F'��FW7B�G2FW7G2�F֖���&�WF��r�6��G&�����R�&VB�&�V�F'��FW7B�G2FW7G2�F֖���&�WF��r�V&Ɨ6���r�&VB�&�V�F'��FW7B�G2FW7G2�F֖���&�WF��r�&Wv&G2�7W'fW�2�&VB�&�V�F'��FW7B�G6�bf��W2��f�7W6VBFW7G276VB������6�BFW7F�C3bf��W2�2�#�FW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2������6�BVF�B���֗C�FWb��VF�B��WfV�ֆ�v��76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW2���v�BF�fb��6�V6��76VB����&�WF��r6��FV�B�6��v��76WB&Wf�Wr��W76v��r�7W7F��W"��VB�5$��4T��T��6��G&�����R�W�W&��V�B�V&Ɨ6���r�ff�ƖFR�����G��&��6��7W'fW�vW2��r7W&f6R7W&6R�7F�&vR&VBf��W&W2��7FVB�b&V�FW&��rV�G��"�W&��f�VVB�W&F����7FFR���6�W&6R6�V6����B&Vf�&Rf���F�72&Vg&W6��cs�Sf��W&vVB6��7W'&V�B���6��vW2��F�72�B6�W&6R&RV&Ɨ6�VB���&�v���6�FW��v�&�B�6�72�&�GV7F���BcFfSs�Fࠢ22�FW7B��6�Wf�FV�6R�WF��BV&Ɩ2�&�V�F&�W0���f�7W6VBWF�6��FW�B��WF�6��&6��F֖�6�V���֖FF�Wv&RV&Ɩ2���B7&��WF��&��F���6��G&7G276VB�2FW7G27&�72R7V�FW2�������6�BFW7F�C3�f��W2�2�CFW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2������6�BVF�B���֗C�FWb��VF�B��WfV�ֆ�v��76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW3�W��7F��r7W&6RVFvR�'V�F��R6��F�&�ƗG�v&���r&V���2���v�BF�fb��6�V6��76VB���6�&VBWF���r��w2&�f�FW"����vƗ7Bf��W&W2�BG&VG2WF�V�F�6FVB6��FW�Bf��W&W22V�f��&�S��WF�6��&6��V�&W'6��f��W&W2�����vW"&�WFR��F���&�&F��s�F�RF֖�6�V��W��6W2&�f��R���f�FR���F�f�6F���&VBv&���w3�֖FF�Wv&R&V6�W2��FV�FVBV&Ɩ2�B�6���R�WF�V�F�6FVB&�WFRwV&G2���6�W&6R6��֗C�&C�#6��W&vVB6�W&6R6�V6����C�VC�s3�ff�VF�BWf�FV�6R�2V&Ɨ6�VBBF�R7W'&V�B'&�6�F�ࠢ22�FW7B��6�Wf�FV�6R��&�WG�6R�fW'f�Wr&VBf��W&P���f�7W6VB�&�WG�6R���R�&W�'G2��B6���V��G�7V�FW3�2f��W2��FW7G276VB������6�BFW7F�CCf��W2�2�C2FW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2������6�BVF�B���֗C�FWb��VF�B��WfV�ֆ�v��76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW3�W��7F��r7W&6RVFvR�'V�F��R6��F�&�ƗG�v&���r&V���2���v�BF�fb��6�V6��76VB�����&�WG�6V��r7W&f6W2�&V�VB&VBf��W&W2f�"����FWV�FV�BF�66�fW'��7F�f�G��7&VF�"��B6���V7F���6�W&6W2&F�W"F��&V�FW&��r�V�G��V�F��&�&B���6�W&6R6��֗C�#3&Svf�F�72&Vg&W6��BV&Ɩ6F���&R��&�w&W72ࠢ22�FW7B��6�Wf�FV�6R��&�WG�6RƗ7F��rFWF��&VBf��W&P���f�7W6VB�&�WG�6R���R��FV��&W�'G2��B6���V��G�7V�FW3�Bf��W2�#FW7G276VB������6�BFW7F�CCf��W2�2�CRFW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2������6�BVF�B���֗C�FWb��VF�B��WfV�ֆ�v��76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW3�W��7F��r7W&6RVFvR�'V�F��R6��F�&�ƗG�v&���r&V���2���v�BF�fb��6�V6��76VB����&�WG�6RƗ7F��rFWF����rF�7F��wV�6�W2f��VB&VG2g&��֗76��r&�w2�B7W&f6W2FWV�FV�B&�B�G'W7B��ffW"��&FW"�7F�&R�&�6Rֆ�7F�'��6��&&�R��B�Vv�F�F���f��W&W2���6�W&6R6��֗C�Ccc�V6C��F�72&Vg&W6��BV&Ɩ6F���&R��&�w&W72ࠢ22�FW7B��6�Wf�FV�6R��&�WG�6R6���V��G�&VBf��W&P���f�7W6VB6���V��G�6�&6�W2&VB�&�V�F'��BF����7V�FW3�"f��W2�rFW7G276VB������6�BFW7F�CC"f��W2�2�CrFW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2������6�BVF�B���֗C�FWb��VF�B��WfV�ֆ�v��76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW3�W��7F��r7W&6RVFvR�'V�F��R6��F�&�ƗG�v&���r&V���2���v�BF�fb��6�V6��76VB���6���V��G�6�&6�W2��rF�7F��wV�6�W2֗76��r֖w&F���2g&��G&�6�V�B6�&6�R��V�&W"�6�&R�Ɨ7F��rf��W&W2�B7W&f6W2F�RffV7FVB6�W&6R�&V�2v�F��WB��F��rW6&�RFF���6�W&6R6��֗C�SvS�s6C6�F�72&Vg&W6��BV&Ɩ6F���&R��&�w&W72ࠢ22�FW7B��6�Wf�FV�6R��&�WG�6R�&FW'2&VBf��W&P���f�7W6VB�&�WG�6R�&FW'2&VB�&�V�F'�7V�FS�f��R�"FW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2������6�BVF�B���֗C�FWb��VF�B��WfV�ֆ�v��76VBv�F�gV��W&&�ƗF�W2���v�BF�fb��6�V6��76VB�����&�WG�6R��&FW'6��rf��26�V&ǒ��F�R&��'��&FW"&VB�B7W&f6W2�&V�VBv&���w2f�"fVR6WGF��w2�Ɨ7F��rF�F�W2�f֖ǒ�V�&W'2�&Wf�Wr��7F�'���B��F�fb6��&F��F���f��W&W2���6�W&6R6��֗C�cS&Vc&�'&�6��B���V&Ɩ6F���fW&�f�VBࠢ22�FW7B��6�Wf�FV�6R��&�WG�6R�W'G2&VBf��W&P���f�7W6VB�&�WG�6R�W'G2&VB�&�V�F'�7V�FS�f��R�"FW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2���v�BF�fb��6�V6��76VB�����&�WG�6R��W'G6��rf��26�V&ǒv�V�6fVB6V&6�W26���B&R&VB�B7W&f6W2�F6���r�Ɨ7F��r�B6fVB�7FFRf��W&W2��7FVB�b&W6V�F��r�V�F��V�G��W'Bf�Wr���gV�����6�BFW7F�CCBf��W2�2�SFW7G276VB������6�BVF�B���֗C�FWb��VF�B��WfV�ֆ�v��76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW3�W��7F��r7W&6RVFvR�'V�F��Rv&���r&V���2v�V�V֗GFVB���6�W&6R6��֗C�Fcf#c�f�'&�6��B���V&Ɩ6F���fW&�f�VBࠢ22�FW7B��6�Wf�FV�6R��&�WG�6R7&VF�'2&VBf��W&P���f�7W6VB�&�WG�6R7&VF�'2&VB�&�V�F'�7V�FS�f��R�"FW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2���v�BF�fb��6�V6��76VB�����&�WG�6R�7&VF�'6��rf��26�V&ǒv�V�7F�&Vg&��G26���B&R&VB�B7W&f6W2f����vW"�&Wf�Wr��B�V��Ɨ7F��rf��W&W2��7FVB�b&W6V�F��r���6���WFR7&VF�"&涖�r���gV�����6�BFW7F�CCRf��W2�2�S2FW7G276VB������6�BVF�B���֗C�FWb��VF�B��WfV�ֆ�v��76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW3�W��7F��r7W&6RVFvR�'V�F��Rv&���r&V���2v�V�V֗GFVB���6�W&6R6��֗C�F6&S�S���'&�6�V&Ɩ6F���fW&�f�VC�&V��FR����W&vR�2VC3C##6V�F��rf���W6�ࠢ22�FW7B��6�Wf�FV�6R��&�WG�6Rf����v��r�B6���V7F���2&VBf��W&W0���f�7W6VBf����v��r�B6���V7F���2&VB�&�V�F'�7V�FW3�"f��W2�BFW7G276VB���gV�����6�BFW7F�CCrf��W2�2�SrFW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2������6�BVF�B���֗C�FWb��VF�B��WfV�ֆ�v��76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW2���v�BF�fb��6�V6��76VB���f����v��r��rF�7F��wV�6�W2f��VBf����r&VBg&���V�G�fVVB�B7W&f6W26fVB�7F�&R��BƗ7F��rf��W&W3�6���V7F���2F�W2F�R6�Rf�"6���V7F���2��FV�2��B6���V7F���Ɨ7F��w2��F�&V7F�'��BFWF��f�Ww2���6�W&6R6��֗C�&c�CF636�'&�6��B���V&Ɩ6F���fW&�f�VBࠢ22�FW7B��6�Wf�FV�6R�v��WB&VBf��W&P���f�7W6VBv��WB&VB�&�V�F'�7V�FS�f��R�"FW7G276VB���gV�����6�BFW7F�CC�f��W2�2�S�FW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2������6�BVF�B���֗C�FWb��VF�B��WfV�ֆ�v��76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW2���v�BF�fb��6�V6��76VB���v��WB6V�B���W��7F�f�G��G&V7W'��v��2����v�6R��B6&G2��rf��6�V&ǒ��&��'�v��WB&VG2�B7W&f6RFWV�FV�B�VFvW"��FV�F�G��6��f�wW&F����6���V7FVB�66�V�B�7��2��B�77VVB�6&Bf��W&W2��7FVB�b6��V�FǒFW&�f��r�W&��"��6���WFRf���6��f�Ww2���6�W&6R6��֗C�#�S�VC�'&�6��B���V&Ɩ6F���fW&�f�VBࠢ22&�w&W726�6��B�##b�r�R3�3 ����fW&��FV6�6���������t������fW&�f�VB6���WF��������V���7W'&V�B6W'f�6S�v��WB����W���fV�V�B��B6���V7FVB�6&B&VB&�V�F&�W2���6���WFVBF��2��FW'fâ6V�B���W��7F�f�G��G&V7W'��v��2����v�6R��B6&G2��rF�7F��wV�6�&��'�f��W&W2g&����7F�fR�V�G�7FFR�B7W&f6RFWV�FV�B&VB�7��2f��W&W2���FW7G2FFVB�WFFVC�FW7G2�v��WB�&VB�&�V�F'��FW7B�G6�"f�7W6VBFW7G2����gV��fW&�f�6F����CC�FW7Bf��W2�2�S�FW7G3�G�V6�V6��Ɩ�C�FWV�FV�7�VF�B�gV��W&&�ƗF�W2��&�GV7F���'V��B�#S&�WFW2��F�fb6�V6���76VB���7W&6R7FGW3�W��7F��r66�V�&�&W2&V���w&VV��&V��FR֖w&F���Ɩ6F����BƗfRv��WB�$�2�&��R�6��7W'&V�7�Wf�FV�6R&V���V�fW&�f�VB���FW����V�B7FGW3�6�W&6RV&Ɩ6F���f����w2F��26�6��C�ƗfRWF�F֖��EES�B��6�F�6�W"�7W&6RV�f��&�ƗG�&V����V�&��6�W'2����FW7BfW&�f�VB6��֗C�#CCcv3sf&Vf�&RF�Rv��WB6�W&6R��7&V�V�B����W�C�V&Ɨ6�F�Rv��WB��7&V�V�B�F�V�6��F��VRF�R&V�����rv��WB&�WFW2�B���W��vV&�����7&����FVw&F���VF�B��22�FW7B��6�Wf�FV�6R�&��Ɩ�r7FFR&VB&�V�F&�W0���f�7W6VB&��Ɩ�r&VB�&�V�F'�7V�FS�f��R�"FW7G276VB���gV�����6�BFW7B����'V��CC�f��W2�2�cFW7G276VB������6�B'V�G�V6�V6��76VB������6�B'V�Ɩ�F�76VBv�F���U4Ɩ�Bv&���w2�"W'&�'3���ǒF�R���v��W�B��2�W�BƖ�FFW&V6F�����F�6R&V���2������6�BVF�B���֗C�FWb��VF�B��WfV�ֆ�v��76VBv�F�gV��W&&�ƗF�W2������6�B'V�'V��F�76VB�BvV�W&FVB#S&�WFW3�W��7F��r7W&6RVFvR�'V�F��R6��F�&�ƗG�v&���r&V���2v�V�V֗GFVB���v�BF�fb��6�V6��76VB���6�V6��WB�6��vR����6�6V���B�'F���rf��6��6VB��&WV�&VB&��Ɩ�r7FFR�&VBW'&�'3�&��Ɩ�r�7W7F��W"w&�FRf��W&W2&WGW&�S2�BG&6���r��F�֗7F�2�7��2f��W&W2&R��vvVB���6�W&6R6��vW2&R7W'&V�FǒV�6��֗GFVBV�F��rV&Ɩ6F����ƗfR7G&�RFW7B���FR�vV&������FV��FV�7���WFvR�&VgV�B��B&V��FR7W&6RWf�FV�6R&V����V��
// Rebuild the audit control document without renumbering previously discovered items.
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const read = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'));
const ui = read('discovery/ui-inventory.json');
const api = read('discovery/api-inventory.json');
const ops = read('discovery/ops-inventory.json');
const snapshot = read('discovery/repository-snapshot.json');
const statePath = path.join(__dirname, 'audit-state.json');
const state = fs.existsSync(statePath) ? read('audit-state.json') : { started: new Date().toISOString(), records: {} };
const records = state.records;
const add = (area, key, name, source, extra = {}) => {
  const id = extra.id || `${area}-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 12).toUpperCase()}`;
  if (records[id] && records[id].key !== key) throw new Error(`Audit ID collision: ${id}`);
  if (!records[id]) records[id] = { id, key, area, name, source, status: 'NOT STARTED', severity: 'Unassessed', tests: 'Pending', fix: 'None', retest: 'Pending', notes: '', ...extra };
  return records[id];
};
for (const r of ui.routes) add('UI', r.source, r.route, r.source, { id: r.id });
for (const r of ui.mobileRoutes) add('MOBILE', r.source, r.route, r.source, { id: r.id });
for (const r of ui.layouts) add('LAYOUT', r.source, r.source, r.source);
for (const r of ui.auxiliaryRoutes) add('ROUTE', r.source, r.route, r.source);
const routeSources = new Set([...ui.routes, ...ui.mobileRoutes, ...ui.layouts].map(r => r.source));
for (const c of ui.components) {
  if (!routeSources.has(c.source)) add('COMPONENT', c.source, c.source, c.source);
  for (const [i, control] of c.controls.entries()) add('CONTROL', `${c.source}:${control.line}:${control.tag}:${i}`, `${control.tag} at line ${control.line}`, c.source, { line: control.line });
}
for (const n of ui.navigation) add('NAV', n.source, n.source, n.source);
for (const n of ui.roleSources) add('ROLE', n.source, `Authorization and role visibility: ${n.source}`, n.source);
for (const n of ui.unfinishedMarkers) for (const [i, marker] of n.markers.entries()) add('INCOMPLETE', `${n.source}:${marker.line}:${i}`, `Triage marker at line ${marker.line}`, n.source, { line: marker.line, notes: marker.text });
for (const r of api.apiRoutes) for (const method of r.methods) add('API', `${r.route}:${method}`, `${method} ${r.route}`, r.file);
for (const r of api.serverActionModules) for (const e of r.exports.filter(e => e.kind === 'function')) add('ACTION', `${r.file}:${e.name}`, e.name, r.file, { line: e.line });
for (const r of api.inlineServerActions) add('ACTION', `${r.file}:${r.name}:${r.line}`, r.name, r.file, { line: r.line });
for (const r of api.serviceModules) for (const e of r.exports.filter(e => e.kind === 'function')) add('SERVICE', `${r.file}:${e.name}`, e.name, r.file, { line: e.line });
for (const r of api.libraryModules) add('LIBRARY', r.file, r.file, r.file);
for (const r of api.workflowGroups) add('FLOW', r.name, r.name, r.sourceFiles.join(', '), { discoveryGroupId: r.discoveryGroupId });
for (const r of ui.workflows ?? []) add('UI-FLOW', r.name, r.name, r.sourceAnchors.join(', '), { id: r.id, expected: r.expectedBehavior });
for (const r of ui.runtimeSurfaces ?? []) add('RUNTIME', r.name, r.name, r.sources.join(', '), { id: r.id });
for (const r of ops.database.tables) add('DB-TBL', r.name, r.name, r.declarations.map(d => `${d.path}:${d.line}`).join(', '), { id: r.id });
for (const r of ops.database.functions) add('DB-RPC', r.name, r.name, r.declarations.map(d => `${d.path}:${d.line}`).join(', '), { id: r.id });
for (const r of ops.database.migrations) add('MIGRATION', r, r, r);
for (const r of ops.cronRoutes) add('JOB', r.route, r.route, r.source);
for (const r of ops.callbackRoutes) add('CALLBACK', r.route, r.route, r.source);
for (const r of ops.storage) add('STORAGE', r.name, r.name, 'discovery/ops-inventory.json');
for (const r of ops.environmentNames) add('ENV', r.name, r.name, 'discovery/ops-inventory.json');
for (const name of ['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY', 'APNS_TEAM_ID', 'APNS_KEY_ID', 'APNS_PRIVATE_KEY', 'APNS_TOPIC', 'APNS_ENVIRONMENT']) add('ENV', name, name, '.env.example; lib/server/native-push.ts');
for (const name of ['nativePushConfigured', 'sendNativePush']) add('SERVICE', `lib/server/native-push.ts:${name}`, name, 'lib/server/native-push.ts');
for (const r of ops.externalHostReferences) add('INTEGRATION', r.host, r.host, 'discovery/ops-inventory.json');
for (const r of ops.integrations ?? []) add('PROVIDER', r.provider, r.purpose, r.sources.join(', '), { id: r.id });
for (const r of [...ops.workflowFiles, ...ops.operationalScripts]) add('DEPLOY', r, r, r);
for (const r of ops.seedFiles) add('SEED', r, r, r);
// Incremental discovery includes our repairs and incoming owner commits. Keep
// the original identity convention (file:function, route:METHOD) when adding
// newly exported boundaries; inspection hashes are evidence, not passing tests.
const incrementalPath = path.join(__dirname, 'discovery/incremental-inventory.json');
if (fs.existsSync(incrementalPath)) {
  const delta = read('discovery/incremental-inventory.json');
  for (const surface of delta.newSurfaceCandidates) {
    const source = surface.canonicalPath;
    const evidence = { line: surface.line, notes: 'Incremental source discovery; see discovery/incremental-inventory.json for inspection commit and SHA-256. Workflow verification pending.' };
    if (surface.kind === 'http-method') add('API', surface.canonicalKey, `${surface.name} ${surface.canonicalKey.split(':')[0]}`, source, evidence);
    else if (surface.kind === 'exported-function') add('SERVICE', `${source}:${surface.name}`, surface.name, source, evidence);
    else if (surface.kind === 'source-file') add(source.startsWith('lib/') ? 'LIBRARY' : 'DEPLOY', source, source, source, evidence);
    else if (surface.kind === 'test-file' || surface.kind === 'support-document') add('SUPPORT', source, source, source, evidence);
    else throw new Error(`Unknown incremental audit surface: ${surface.kind}`);
  }
  for (const version of [delta.environmentDelta.worktree, delta.environmentDelta.incoming]) {
    for (const name of version.addedNamesInChangedFiles) add('ENV', name, name, 'discovery/incremental-inventory.json');
  }
}
// Follow-up source discovery retains the same file/function/route identity rules.
const socialDeltaPath = path.join(__dirname, 'discovery/social-rewards-inventory.json');
if (fs.existsSync(socialDeltaPath)) {
  const delta = read('discovery/social-rewards-inventory.json');
  for (const file of delta.files) {
    const evidence = { notes: 'Source discovery only; exact hashes and baseline in discovery/social-rewards-inventory.json. Full workflow verification remains separate.' };
    if (file.isNew) add(file.path.startsWith('lib/') ? 'LIBRARY' : 'SUPPORT', file.path, file.path, file.path, evidence);
    for (const fn of file.addedExportedFunctions ?? []) {
      if (file.apiRoute && file.httpMethods.includes(fn.name)) add('API', `${file.apiRoute}:${fn.name}`, `${fn.name} ${file.apiRoute}`, file.path, { ...evidence, line: fn.line });
      else if (file.kind === 'production-source') add('SERVICE', `${file.path}:${fn.name}`, fn.name, file.path, { ...evidence, line: fn.line });
    }
  }
  for (const item of delta.environment) add('ENV', item.name, item.name, 'discovery/social-rewards-inventory.json');
  for (const [key, source, line, name] of [
    ['social-studio-existing-post-review', 'components/social/studio-form.tsx', 241, 'Open the persisted post after a publish attempt'],
    ['social-studio-lost-response-review', 'components/social/studio-form.tsx', 249, 'Review posts when the create response is unconfirmed'],
    ['social-x-callback-recovery', 'app/api/social/x/callback/route.ts', 24, 'Return to Social Accounts after failed X authorization'],
  ]) add('CONTROL', key, name, source, { line, notes: 'New recovery control; browser/route execution evidence in the social cycle. Complete workflow and accessibility verification remain separate.' });
}
for (const inventory of ['care-delivery-inventory.json', 'capture-scheduling-inventory.json', 'text-messaging-inventory.json', 'auth-session-inventory.json', 'auth-cookie-inventory.json', 'auth-signout-inventory.json', 'password-adoption-inventory.json', 'weekly-meal-inventory.json', 'guardian-policy-inventory.json']) {
  if (!fs.existsSync(path.join(__dirname, 'discovery', inventory))) continue;
  const delta = read(`discovery/${inventory}`);
  for (const file of delta.files) {
    const evidence = { notes: `Source discovery only; exact committed hashes and baseline in discovery/${inventory}. Full workflow verification remains separate.` };
    if (file.isNew) add(file.path.startsWith('lib/') ? 'LIBRARY' : 'SUPPORT', file.path, file.path, file.path, evidence);
    if (file.isNew && file.pageRoute) add('ROUTE', file.path, file.pageRoute, file.path, evidence);
    for (const fn of file.addedExportedFunctions) {
      if (file.apiRoute && file.httpMethods.includes(fn.name)) add('API', `${file.apiRoute}:${fn.name}`, `${fn.name} ${file.apiRoute}`, file.path, { ...evidence, line: fn.line });
      else if (file.kind === 'production-source') add('SERVICE', `${file.path}:${fn.name}`, fn.name, file.path, { ...evidence, line: fn.line });
    }
    if (file.apiRoute?.startsWith('/api/cron/')) add('JOB', file.apiRoute, file.apiRoute, file.path, evidence);
    for (const name of file.environmentNames) add('ENV', name, name, file.path, evidence);
  }
}
if (fs.existsSync(path.join(__dirname, 'discovery/auth-signout-inventory.json'))) {
  for (const [key, source, line, name] of [
    ['signout-review-current-session', 'components/auth/sign-out-form.tsx', 76, 'Review a changed or unreadable session before a new explicit logout decision'],
    ['signout-completion-explicit-decision', 'components/auth/sign-out-completion.tsx', 30, 'Explicitly sign out after missing, expired or changed completion intent'],
    ['signout-completion-continue', 'components/auth/sign-out-completion.tsx', 33, 'Continue to the current account without signing it out'],
  ]) add('CONTROL', key, name, source, { line, notes: 'New control discovered at source44811fb6; controlled browser execution is recorded in auth-signout-cycle.md. Complete deployed workflow and accessibility verification remain separate.' });
}
if (fs.existsSync(path.join(__dirname, 'discovery/capture-scheduling-inventory.json'))) {
  for (const [key, source, line, name] of [
    ['quick-capture-unconfirmed-review', 'components/app/quick-capture.tsx', 313, 'Review the destination after an unconfirmed Quick Capture save'],
    ['capture-shell-unconfirmed-review', 'components/capture/capture-shell.tsx', 306, 'Review the destination after an unconfirmed routed capture'],
    ['voice-capture-unconfirmed-review', 'components/modules/voice-module.tsx', 236, 'Review the destination after an unconfirmed voice capture'],
    ['social-studio-explicit-timezone', 'components/social/studio-form.tsx', 378, 'Choose the timezone for a scheduled social post'],
  ]) add('CONTROL', key, name, source, { line, notes: 'New control discovered at source910cd271; targeted browser evidence is recorded in capture-scheduling-checkpoint.md. Complete workflow/accessibility verification remains separate.' });
}
// Every tracked file is also classified, including documentation, tests, assets,
// scripts, dependency manifests and generated schema. Discovery is not verification.
const mappedSources = new Set(Object.values(records).map(r => r.source));
for (const f of snapshot.files) if (!mappedSources.has(f.path)) add('SUPPORT', f.path, f.path, f.path);
const major = [
  ['ARCH-001', 'Repository architecture and dependency boundaries'],
  ['DEPLOY-001', 'Clean install, build, types, lint and production startup'],
  ['TEST-001', 'Current baseline full automated unit suite'],
  ['AUTH-001', 'Registration, verification, OAuth and recovery'],
  ['AUTH-002', 'Persistent sessions through refresh, navigation and restart until explicit sign-out'],
  ['AUTHZ-001', 'Tenant and role authorization through pages, actions, APIs and database'],
  ['INT-001', 'Contact Center authenticated provider callbacks and durable intake replay'],
  ['PUSH-001', 'Notification push delivery, failure retention and acknowledgement'],
  ['PUSH-002', 'Native push through supported FCM HTTP v1'],
  ['EMAIL-001', 'Resend signed event suppression persistence and failed-event replay'],
  ['MOBILE-001', 'PWA service worker first entry, updates and lifecycle'],
  ['SEC-001', 'Private family media storage and URL access'],
  ['SOCIAL-001', 'Live social publishing connectors'],
  ['A11Y-001', 'Keyboard, focus, labels, errors and assistive technology'],
  ['PERF-001', 'Page, client bundle, network and database performance'],
  ['UI-001', 'Small phone through wide desktop interactions and browser errors'],
  ['DATA-001', 'Resource CRUD, persistence, concurrent operations and failed reads'],
  ['AI-001', 'AI permissions, input context, provider boundaries and reliable execution'],
  ['PAY-001', 'Billing lifecycle and entitlement verification in sandbox only'],
  ['SEC-002', 'Redirects, validation, secrets, cross-site and upload security'],
  ['REGRESSION-001', 'Second full regression after individual audit completion'],
];
for (const [id, name] of major) add(id.split('-')[0], id, name, '', { id, severity: 'High' });
const now = new Date().toISOString();
const rows = Object.values(records);
const counts = Object.fromEntries(['NOT STARTED','IN PROGRESS','PASS','FIXED + PASS','BLOCKED','FAIL'].map(s => [s, rows.filter(r => r.status === s).length]));
const completed = counts.PASS + counts['FIXED + PASS'] + rows.filter(r => r.status === 'BLOCKED' && r.blockerFullyInvestigated === true).length;
const symbols = { 'NOT STARTED':'⬜ NOT STARTED', 'IN PROGRESS':'🔄 IN PROGRESS', PASS:'✅ PASS', 'FIXED + PASS':'🛠 FIXED + PASS', BLOCKED:'⚠️ BLOCKED', FAIL:'❌ FAIL' };
const cell = s => String(s ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
const lines = ['# Final Production Audit', '', '## Audit Status', `- Started: ${state.started}`, `- Last Updated: ${now}`, `- Total Audit Items: ${rows.length}`, `- Not Started: ${counts['NOT STARTED']}`, `- In Progress: ${counts['IN PROGRESS']}`, `- Passed: ${counts.PASS}`, `- Fixed + Passed: ${counts['FIXED + PASS']}`, `- Blocked: ${counts.BLOCKED}`, `- Failed: ${counts.FAIL}`, `- Overall Completion: ${(100 * completed / rows.length).toFixed(2)}%`, '', '## Status Legend', ...Object.values(symbols).map(s => `- ${s}`), '', '## Release Gate', 'PRODUCTION READY: NO', '', '## Critical Blockers'];
const risks = rows.filter(r => ['Critical', 'High'].includes(r.severity) && !['PASS', 'FIXED + PASS'].includes(r.status) && r.issue);
lines.push(...(risks.length ? risks.map(r => `- ${r.id}: ${r.remaining || r.issue}`) : ['- Comprehensive verification remains unfinished.']));
lines.push('', '## Audit Summary', '| ID | Area | Feature / Service | Status | Severity | Tests | Fix | Retest | Notes |', '|---|---|---|---|---|---|---|---|---|');
for (const r of rows) lines.push(`| ${[r.id, r.area, r.name, symbols[r.status], r.severity, r.tests, r.fix, r.retest, r.notes].map(cell).join(' | ')} |`);
lines.push('', '## Inventory and evidence rules', '', `Baseline: ${snapshot.head}. Discovery covered ${snapshot.trackedFiles} tracked files. IDs persist in [audit-state.json](docs/final-audit/audit-state.json); additions never remove or renumber existing records.`, '', 'Each interaction source site has a CONTROL ID. Repeated or data-generated controls require representative rendered instances, permissions and states. File, function, API, control and complete-workflow records are distinct verification scopes; passing a unit test does not pass the enclosing workflow. Counts measure these explicit audit obligations, not product-development completion. New discovery can increase the denominator.', '', 'Source, import, table, RPC, role, provider, control and candidate-test mappings are retained in [UI discovery](docs/final-audit/discovery/ui-inventory.json), [API discovery](docs/final-audit/discovery/api-inventory.json), [operations discovery](docs/final-audit/discovery/ops-inventory.json), and [tracked-file snapshot](docs/final-audit/discovery/repository-snapshot.json). Historical declarations are not proof of the applied database catalog. No source marker is presumed broken without triage.', '', 'SQL/migration changes and shared navigation edits remain outside the earlier authorized implementation boundaries; read-only audit continues. No live financial transactions. Existing shared dependencies are not modified. External BLOCKED requires exhausted local verification and an exact demonstrated dependency; missing verification remains NOT STARTED or IN PROGRESS.', '', '## Detailed feature records');
const detailedIds = new Set([...major.map(([id]) => id), ...rows.filter(r => r.issue).map(r => r.id)]);
for (const id of detailedIds) {
  const r = records[id];
  lines.push('', `### ${r.id} — ${r.name}`, '', `Status: ${symbols[r.status]}`, `Severity: ${r.severity}`, `Route(s), components, actions, tables and providers: ${r.source || 'Trace using linked discovery inventory; record exact exercised chain before passing.'}`, '', '#### Expected Behavior', r.expected || 'The complete supported workflow performs authorized actions, persists intended state, handles invalid input and unavailable dependencies, and reports an accurate outcome across refresh, navigation and supported viewports.', '', '#### Test Cases', '- [ ] Happy path through every required layer and persisted readback', '- [ ] Missing, invalid, unauthorized and cross-tenant inputs', '- [ ] Empty, loading, provider failure and retry states', '- [ ] Duplicate submissions and concurrent execution where applicable', '- [ ] Refresh, restart, keyboard and mobile behavior where applicable', '- [ ] Console and network inspection; related regression', '', '#### Issues Found', r.issue || 'No complete workflow finding yet; investigation pending.', '', '#### Fixes Applied', r.fix, '', '#### Retest Results', r.retest, '', '#### Evidence', r.tests, '', '#### Final Status', symbols[r.status]);
}
for (const group of api.workflowGroups) {
  const r = rows.find(r => r.area === 'FLOW' && r.key === group.name);
  lines.push('', `### ${r.id} — ${r.name}`, '', `Status: ${symbols[r.status]}`, 'Severity: Unassessed', `Source chain: ${group.sourceFiles.join(', ')}`, `API routes: ${group.apiRoutes.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(', ') || 'None discovered directly'}`, '', '#### Expected Behavior', 'Each supported user action completes validation, authorization, business logic, durable storage, any provider operation, and an accurate user confirmation. Exact actions, permission call sites, table/RPC evidence and candidate tests are linked by discoveryGroupId in API inventory.', '', '#### Test Cases', '- [ ] Every action and input boundary, including hidden/admin controls', '- [ ] Role and tenant isolation through all server and data layers', '- [ ] Complete CRUD and persisted readback for related resources', '- [ ] Provider timeout, malformed response, retry and duplicate handling', '- [ ] Empty/loading/error states, direct navigation and refresh', '- [ ] Responsive, keyboard, console/network and related regressions', '', '#### Issues Found', r.issue || 'Pending full workflow execution.', '', '#### Fixes Applied', r.fix, '', '#### Retest Results', r.retest, '', '#### Evidence', r.tests, '', '#### Final Status', symbols[r.status]);
}
lines.push('', '# Final Regression');
for (const title of ['Build','Type Check','Lint','Automated Tests','Authentication','Authorization','Core User Journeys','APIs','Database','Integrations','Mobile / Responsive','Accessibility','Security','Performance']) lines.push('', `## ${title}`, 'Status: NOT STARTED — second regression follows individual verification; baseline evidence is not final sign-off.');
lines.push('', '## Known Blockers', 'Full verification remains incomplete. Confirmed defects appear above; no dependency is classified BLOCKED before all local work is exhausted.', '', '## Remaining Issues', ...risks.map(r => `- ${r.id}: ${r.remaining || r.issue}`), '', '## Production Readiness', 'NO', '', '## Final Sign-Off', 'Pending', '');
state.lastUpdated = now;
fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
fs.writeFileSync(path.join(root, 'finalaudit.md'), lines.join('\n'));
console.log(JSON.stringify({ items: rows.length, counts, completion: (100 * completed / rows.length).toFixed(2), path: path.join(root, 'finalaudit.md') }));

// Offline review only. This module has no database client, credential lookup,
// network request, SQL execution, or production workflow dispatch.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  assertNoNewerMigrations, assertPreflight, boundaryOf, readReleaseFiles,
} from '../../../scripts/apply-production-forward-release.mjs';

if (process.argv.length !== 2) throw new Error('Review accepts no options; it cannot apply a release.');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = path => readFileSync(resolve(root, path), 'utf8');
const parse = path => JSON.parse(read(path));
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const snapshotFile = 'docs/final-audit/rollout-20261008/boundary.snapshot.json';
const snapshot = parse(snapshotFile);
const manifest = parse('supabase/production-forward-release.json');
if (snapshot.project_ref !== manifest.projectRef) throw new Error('Snapshot project does not match the release target.');
for (const field of ['tables', 'columns', 'constraints', 'policies', 'functions', 'migrations']) {
  if (!Array.isArray(snapshot[field])) throw new Error('Incomplete catalog snapshot: ' + field);
}
const gate = check => {
  try { check(); return { passed: true }; }
  catch (cause) { return { passed: false, reason: cause.message }; }
};
// Verify the existing reviewed bytes; this does not re-pin or generate apply SQL.
const releaseFiles = readReleaseFiles(manifest, path => read(path));
const runnable = readdirSync(resolve(root, 'supabase/migrations')).filter(name => /^\d+_.*\.sql$/.test(name)).sort();
const held = readdirSync(resolve(root, 'supabase/reserved')).filter(name => /^\d+_.*\.sql$/.test(name)).sort();
const boundary = boundaryOf(snapshot, manifest);
const drift = Object.fromEntries(Object.keys(manifest.boundary).map(key => {
  const expected = manifest.boundary[key];
  const actual = boundary[key];
  const expectedSet = new Set(expected.map(canonical));
  const actualSet = new Set(actual.map(canonical));
  return [key, {
    expectedCount: expected.length, actualCount: actual.length,
    addedOrChanged: actual.filter(row => !expectedSet.has(canonical(row))),
    removedOrChanged: expected.filter(row => !actualSet.has(canonical(row))),
  }];
}));
const schema = parse('docs/final-audit/schema-prerequisites-20261008.json');
const missingTables = [...new Set(schema.results.filter(row => !row.table_present).map(row => row.label.split('.')[0]))].sort();
const checksum = path => ({ path, sha256Lf: hash(read(path).replace(/\r\n/g, '\n')) });
const references = runnable.flatMap(file => {
  const path = 'supabase/migrations/' + file;
  const sql = read(path);
  const tables = missingTables.filter(table => new RegExp('\\bpublic\\s*\\.\\s*"?' + table + '"?\\b', 'i').test(sql));
  return tables.length ? [{ ...checksum(path), referencedMissingTables: tables }] : [];
});
const referenceReceipt = parse('docs/final-audit/rollout-20261008/wallet-family-integrity.fixture-results.json');
for (const file of referenceReceipt.files) {
  const path = 'docs/final-audit/rollout-20261008/' + file.name;
  if (hash(read(path)) !== file.sha256) throw new Error('Reference fixture receipt is stale: ' + file.name);
}
const expectedLedger = new Set(manifest.baseline.map(canonical));
const actualLedger = new Set(snapshot.migrations.map(canonical));
console.log(JSON.stringify({
  status: 'REVIEW_REQUIRED_NOT_APPLY_READY',
  productionActionsAuthorized: false,
  target: snapshot.project_ref,
  observedAt: snapshot.observed_at,
  scope: snapshot.scope,
  evidence: [checksum(snapshotFile), checksum('supabase/production-forward-release.json')],
  legacyRelease: {
    name: manifest.release,
    checksumValidation: 'passed',
    files: releaseFiles.map(({ file }) => checksum('supabase/migrations/' + file)),
    sourceInventoryGate: gate(() => assertNoNewerMigrations(runnable, manifest)),
    liveBaselineGate: gate(() => assertPreflight(snapshot, manifest)),
    ledger: {
      expectedCount: manifest.baseline.length, actualCount: snapshot.migrations.length,
      addedOrChanged: snapshot.migrations.filter(row => !expectedLedger.has(canonical(row))),
      removedOrChanged: manifest.baseline.filter(row => !actualLedger.has(canonical(row))),
    },
    boundaryDrift: drift,
    missingRequiredProtectedTables: manifest.requiredTables.filter(name => !snapshot.tables.some(table => table.name === name && table.rls)),
    newTablesAlreadyPresent: manifest.newTables.filter(name => snapshot.tables.some(table => table.name === name)),
    workerRpc: snapshot.workerRpc,
  },
  schemaPrerequisites: { complete: schema.complete, incomplete: schema.incomplete, missingTables },
  heldCandidates: held.map(file => ({ ...checksum('supabase/reserved/' + file), disposition: 'HELD; allocation unchanged; no promotion authorized' })),
  walletReferenceCandidate: {
    disposition: 'UNALLOCATED; structural fixture only; existing-data disposition and full-schema rehearsal required; no application authorized',
    files: referenceReceipt.files,
    receipt: checksum('docs/final-audit/rollout-20261008/wallet-family-integrity.fixture-results.json'),
  },
  moneyCandidateReview: {
    qualification: 'Review inputs only, not an apply list. Existing-data disposition and dependency/role rehearsal remain required.',
    evidence: ['migration-0306-live-metadata.json', 'money-data-preflight.json'].map(name => checksum('docs/final-audit/rollout-20261008/' + name)),
    migrations: [
      '0304_economy_invest_decision_guard.sql',
      '0306_money_instructions_are_not_member_writable.sql',
      '0311_family_scoped_references.sql',
      '0447_an_approved_investment_can_actually_be_approved.sql',
    ].map(file => checksum('supabase/migrations/' + file)),
  },
  referenceInventory: {
    qualification: 'Qualified public-table textual references including comments; misses unqualified/dynamic SQL. Review inputs, not a dependency closure or apply list.',
    files: references,
  },
}, null, 2));

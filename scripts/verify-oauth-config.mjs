// Does this deployment's OAuth configuration match what the providers expect?
//
// Run it BEFORE a deploy, not after the consent screen turns into a 400:
//
//   node scripts/verify-oauth-config.mjs           # values from .env / .env.local
//   npm run verify:oauth
//
// No network calls and no secrets printed — only whether each value is present,
// whether its SHAPE is right, and whether the values that must agree do. Exit 1
// on any error so CI or a deploy hook can gate on it.
import nextEnv from '@next/env';
import { checkOAuthConfig, summarize } from './lib/oauth-config-check.mjs';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const findings = checkOAuthConfig(process.env);
const { errors, warnings, notes } = summarize(findings);

const ICON = { error: '✗', warn: '!', info: '·' };
function print(group, title) {
  if (group.length === 0) return;
  console.log(`\n${title}`);
  for (const f of group) console.log(`  ${ICON[f.level]} ${f.key}: ${f.message}`);
}

print(errors, 'Errors — these will fail at the provider');
print(warnings, 'Warnings — legitimate in some setups, but check them');
print(notes, 'Notes');

console.log('');
if (errors.length === 0) {
  console.log(`OAuth configuration looks consistent (${warnings.length} warning(s), ${notes.length} note(s)).`);
  console.log('Shape is all this proves. A client id that is well-formed but wrong, or a');
  console.log('redirect URI that is well-formed but unregistered, still fails at Google —');
  console.log('run the live round-trip in docs/runbooks/LB-006-provider-callback-smoke.md.');
} else {
  console.log(`${errors.length} configuration error(s). Fix these before deploying.`);
}
process.exit(errors.length === 0 ? 0 : 1);

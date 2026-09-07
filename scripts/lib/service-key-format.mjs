// Pure helpers behind scripts/verify-service-role-key.mjs.
//
// Separated so they can be unit tested without a live project or any real
// credential: everything here is string inspection, and none of it needs — or
// is ever given — a working key.

/**
 * Describe a key WITHOUT revealing it.
 *
 * Format is the diagnosis. A project on Supabase's new API-key system needs an
 * `sb_secret_…` service key; a legacy `eyJ…` JWT left behind by the migration is
 * exactly what the gateway rejects as "Unregistered API key", and a value that
 * is not a JWT at all is what Storage reports as "Invalid Compact JWS".
 */
export function describeKey(key) {
  const trimmed = key.trim();
  let format = 'unrecognised';
  if (trimmed.startsWith('sb_secret_')) format = 'secret';
  else if (trimmed.startsWith('sb_publishable_')) format = 'publishable';
  else if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(trimmed)) format = 'legacy-jwt';
  else if (/^(["']).*\1$/.test(trimmed)) format = 'quoted';
  return { format, untrimmed: key !== trimmed, length: trimmed.length };
}

/** Human wording for a format code. */
export const FORMAT_LABEL = {
  secret: 'new-format secret key (sb_secret_…)',
  publishable: 'new-format PUBLISHABLE key (sb_publishable_…) — that is the public key, not the secret one',
  'legacy-jwt': 'legacy JWT (eyJ…)',
  quoted: 'wrapped in quotes — strip them',
  unrecognised: 'unrecognised',
};

/** Which key scheme a project is on, judged from its public publishable key. */
export function projectScheme(anonKey) {
  if (!anonKey) return null;
  return anonKey.trim().startsWith('sb_publishable_') ? 'new-format' : 'legacy-jwt';
}

/**
 * Does the service key belong to the same scheme as the project?
 * Returns null when there is nothing meaningful to compare.
 */
export function schemeMismatch(anonKey, serviceFormat) {
  const scheme = projectScheme(anonKey);
  if (!scheme) return null;
  if (serviceFormat === 'unrecognised' || serviceFormat === 'quoted') return null;
  const serviceScheme = serviceFormat === 'legacy-jwt' ? 'legacy-jwt' : 'new-format';
  return scheme === serviceScheme ? null : { project: scheme, key: serviceScheme };
}

/** Whether the failures name the CREDENTIAL rather than the query. */
export function isCredentialRejection(details) {
  const text = details.join(' ').toLowerCase();
  return text.includes('api key') || text.includes('jws') || text.includes('jwt');
}

// Is this deployment's OAuth configuration one that the providers will accept?
//
// Pure functions over a plain env object — no network, no secrets printed. The
// caller (scripts/verify-oauth-config.mjs) supplies `process.env`; the tests
// supply fixtures.
//
// This exists because every OAuth failure this codebase has shipped was a
// CONFIGURATION failure that the provider reported as an unnamed 400:
//
//   Error 400: invalid_request        — redirect_uri was "undefined/api/..."
//   Error 400: redirect_uri_mismatch  — the two legs of one flow disagreed
//   invalid_client                    — a trailing newline rode along on a paste
//   ?error=not_configured             — `??` treated "" as a present value
//
// Not one of those names the variable at fault. Every check below turns one of
// them into a line that does.

/** A value that is SET but empty or all-whitespace. `??` readers treat it as present. */
export function isBlankish(raw) {
  return raw !== undefined && raw.trim() === '';
}

/** A value whose stored form differs from what is actually sent. The paste artifact. */
export function hasEdgeWhitespace(raw) {
  return typeof raw === 'string' && raw.trim() !== '' && raw !== raw.trim();
}

/** How a redirect URI must look, per provider leg. Path is compared byte-exact. */
export const REDIRECT_URIS = [
  { key: 'GOOGLE_CALENDAR_REDIRECT_URI', path: '/api/google/calendar/callback', required: false },
  { key: 'GOOGLE_SYNC_REDIRECT_URI', path: '/api/sync/google/callback', required: false },
  { key: 'MICROSOFT_SYNC_REDIRECT_URI', path: '/api/sync/microsoft/callback', required: false },
];

export const CREDENTIAL_PAIRS = [
  { id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET', label: 'Google login / read-only calendar' },
  { id: 'GOOGLE_SYNC_CLIENT_ID', secret: 'GOOGLE_SYNC_CLIENT_SECRET', label: 'Google two-way sync' },
  { id: 'MICROSOFT_SYNC_CLIENT_ID', secret: 'MICROSOFT_SYNC_CLIENT_SECRET', label: 'Microsoft Graph sync' },
];

export const SCOPE_KEYS = [
  'GOOGLE_SYNC_CALENDAR_SCOPES',
  'GOOGLE_SYNC_CALENDAR_READONLY_SCOPE',
  'GOOGLE_SYNC_TASKS_SCOPES',
];

function finding(level, key, message) {
  return { level, key, message };
}

function checkPresence(env, key, out) {
  const raw = env[key];
  if (isBlankish(raw)) {
    // Deliberately an error, not a warning: a blank value is WORSE than an
    // absent one. Absent falls back; blank defeats the fallback in any reader
    // still using `??`, and reads as "configured" to any truthiness check that
    // forgets to trim.
    out.push(finding('error', key, 'set but blank — unset it entirely rather than assigning an empty value'));
    return null;
  }
  if (hasEdgeWhitespace(raw)) {
    out.push(finding('error', key, 'has leading/trailing whitespace — the provider compares byte-exact and answers with an error that names nothing'));
  }
  return raw === undefined ? undefined : raw.trim();
}

/** Google client ids are structurally recognisable; a wrong paste usually is not. */
function checkGoogleClientId(key, value, out) {
  if (!value) return;
  if (!value.endsWith('.apps.googleusercontent.com')) {
    out.push(finding('warn', key, 'does not end in .apps.googleusercontent.com — this may be the client SECRET or a truncated paste'));
  }
}

function checkSecretShape(key, value, out) {
  if (!value) return;
  if (value.endsWith('.apps.googleusercontent.com')) {
    out.push(finding('error', key, 'looks like a client ID, not a secret — the two are swapped'));
  }
}

export function checkCredentials(env) {
  const out = [];
  for (const { id, secret, label } of CREDENTIAL_PAIRS) {
    const idValue = checkPresence(env, id, out);
    const secretValue = checkPresence(env, secret, out);
    if (id.startsWith('GOOGLE')) checkGoogleClientId(id, idValue, out);
    checkSecretShape(secret, secretValue, out);
    // Half a pair is the failure mode worth naming: the flow reports itself
    // "not configured" and points at neither variable.
    if (idValue && !secretValue) out.push(finding('error', secret, `${label}: client id is set but the secret is not — the token exchange will fail as invalid_client`));
    if (!idValue && secretValue) out.push(finding('error', id, `${label}: secret is set but the client id is not`));
  }
  const login = env.GOOGLE_CLIENT_ID?.trim();
  const sync = env.GOOGLE_SYNC_CLIENT_ID?.trim();
  if (!sync && login) {
    out.push(finding('info', 'GOOGLE_SYNC_CLIENT_ID', 'carries no value, so two-way sync falls back to the GOOGLE_CLIENT_ID pair — BOTH sync redirect URIs must then be registered on that one client'));
  }
  if (sync && login && sync === login) {
    out.push(finding('info', 'GOOGLE_SYNC_CLIENT_ID', 'identical to GOOGLE_CLIENT_ID — a single-client setup, which works, but the sensitive calendar scopes then ride on the sign-in client'));
  }
  return out;
}

export function checkRedirectUris(env, { appUrl } = {}) {
  const out = [];
  const base = appUrl?.trim().replace(/\/+$/, '');
  for (const { key, path } of REDIRECT_URIS) {
    const value = checkPresence(env, key, out);
    if (!value) {
      if (value === undefined) {
        out.push(finding('info', key, `unset — the callback URL is derived from the request origin as <origin>${path}, which must be registered in the provider console for every origin the flow is used from`));
      }
      continue;
    }
    let url;
    try {
      url = new URL(value);
    } catch {
      out.push(finding('error', key, 'is not an absolute URL — the provider rejects it as invalid_request'));
      continue;
    }
    const localhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !localhost) {
      out.push(finding('error', key, 'is not https — Google refuses a non-https redirect URI for anything but localhost'));
    }
    if (url.pathname !== path) {
      out.push(finding('error', key, `path is "${url.pathname}" but the route is "${path}" — the callback will 404 or mismatch`));
    }
    if (url.search || url.hash) {
      out.push(finding('error', key, 'carries a query string or fragment — a registered redirect URI must be bare'));
    }
    if (base && !localhost) {
      const appHost = (() => { try { return new URL(base).host; } catch { return null; } })();
      if (appHost && appHost !== url.host) {
        // Legitimate (a vanity domain fronting the deploy), so a warning — but
        // it is also exactly what redirect_uri_mismatch looks like from here.
        out.push(finding('warn', key, `host "${url.host}" differs from NEXT_PUBLIC_APP_URL host "${appHost}" — intentional only if the console registers this host`));
      }
    }
  }
  return out;
}

export function checkAppUrl(env) {
  const out = [];
  const value = checkPresence(env, 'NEXT_PUBLIC_APP_URL', out);
  if (value === undefined) {
    out.push(finding('warn', 'NEXT_PUBLIC_APP_URL', 'unset — the calendar redirect URI then falls back to the request origin, which differs per preview deployment and will not be registered'));
    return out;
  }
  if (!value) return out;
  if (!/^https?:\/\/\S+$/.test(value)) {
    out.push(finding('error', 'NEXT_PUBLIC_APP_URL', 'is not an absolute http(s) URL — it is interpolated into redirect URIs verbatim'));
  } else if (value.endsWith('/')) {
    out.push(finding('warn', 'NEXT_PUBLIC_APP_URL', 'has a trailing slash — harmless here (it is stripped) but not in every consumer'));
  }
  return out;
}

export function checkScopes(env) {
  const out = [];
  for (const key of SCOPE_KEYS) {
    const value = checkPresence(env, key, out);
    if (!value) continue;
    for (const scope of value.split(/\s+/)) {
      if (!/^https:\/\/www\.googleapis\.com\/auth\/\S+$/.test(scope)) {
        out.push(finding('error', key, `"${scope}" is not a Google scope URL — the whole scope string is rejected`));
      }
    }
  }
  return out;
}

/** Every check, in the order a reader wants them. */
export function checkOAuthConfig(env) {
  const appUrl = env.NEXT_PUBLIC_APP_URL;
  return [
    ...checkAppUrl(env),
    ...checkCredentials(env),
    ...checkRedirectUris(env, { appUrl }),
    ...checkScopes(env),
  ];
}

export function summarize(findings) {
  return {
    errors: findings.filter((f) => f.level === 'error'),
    warnings: findings.filter((f) => f.level === 'warn'),
    notes: findings.filter((f) => f.level === 'info'),
  };
}

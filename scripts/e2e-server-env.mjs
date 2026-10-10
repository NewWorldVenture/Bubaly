// The environment of the Next server the E2E suite runs against.
//
// The server is a real production build, so a real flow reaches its real side
// effects: submitting feedback (onFeedbackSubmitted) files a GitHub issue and
// emails the super admins whenever their keys are configured. The suite's
// browser routing cannot see those requests, because the server makes them.
// So their keys are blanked before startup. A blank, not a deletion: Next
// loads `.env*` files only for keys the process does not already have, and an
// empty string is one it has (tests/an-e2e-server-files-no-issue-and-sends-no-mail.test.ts).
export const OUTBOUND_PROVIDER_KEYS_OFF = Object.freeze({
  GITHUB_TOKEN: '',
  GITHUB_FEEDBACK_TOKEN: '',
  RESEND_API_KEY: '',
});

export function e2eServerEnv(base, port) {
  return {
    ...base,
    PLAYWRIGHT_PORT: port,
    PLAYWRIGHT_EXTERNAL_SERVER: '1',
    NEXT_PUBLIC_APP_URL: base.NEXT_PUBLIC_APP_URL ?? `http://localhost:${port}`,
    NEXT_PUBLIC_SUPABASE_URL:
      base.NEXT_PUBLIC_SUPABASE_URL ?? 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY:
      base.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'dummy-anon-key',
    SUPABASE_SERVICE_ROLE_KEY:
      base.SUPABASE_SERVICE_ROLE_KEY ?? 'dummy-service-role-key',
    ...OUTBOUND_PROVIDER_KEYS_OFF,
  };
}

// The rule lives in shared/ so the native app, which Metro bundles only from
// mobile/, design/ and shared/, resolves its active family the same way as the
// server contexts it sends that family to. See shared/auth/active-membership.ts.
export { chooseActiveMembership, type MembershipRow } from '@/shared/auth/active-membership';

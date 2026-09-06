// lib/trust/ledger.ts — who writes the trust ledger.
//
// trust_audit_logs is the record a family can point at to say "this is what
// Bubaly did and this is who said yes". 0260 removed the member INSERT policy,
// so the only writer left is server code holding the service role. Every
// recorder in the codebase goes through this one name, which is the general
// `serverWriter` under a name that says what it is for here.
import 'server-only';
export { serverWriter as ledgerWriter } from '@/lib/supabase/service-writer';

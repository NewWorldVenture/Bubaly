'use client';

// Settings › Privacy. Four cards, each of which says exactly what it can
// stand behind:
//   • Export — streams a role-scoped JSON file from /api/privacy/export; a
//     failed build is a retryable error, never a partial file.
//   • Recent exports and Who accessed what — read from `trust_audit_logs`,
//     the ledger the export route writes to BEFORE it sends bytes. A read
//     that fails renders a retryable error; RLS lets only parents and adults
//     read the ledger, so other roles are told that instead of shown a blank.
//   • Sessions — Supabase Auth exposes only the current device's session to
//     the browser, and the card says so rather than listing one and implying
//     it is all of them.
//   • Deletion — there is no deletion button because there is no deletion
//     table yet; the path is a person, and the card says a person confirms.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Download, FileJson, History, MonitorSmartphone, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useApp } from '@/components/app/app-context';
import { useTranslations } from '@/components/i18n/locale-provider';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { isManager } from '@/lib/constants/roles';
import { fmtDateTime } from '@/lib/utils/format';
import { sessionStrength, type Assurance } from '@/lib/auth/mfa';

type AuditRow = {
  id: string;
  actor_kind: string;
  actor_id: string | null;
  domain: string | null;
  capability: string | null;
  decision: string;
  reason: string | null;
  created_at: string;
};

type Loaded<T> = { status: 'loading' } | { status: 'error' } | { status: 'ok'; data: T };

function RetryNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useTranslations();
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
      <span className="min-w-0 flex-1">{message}</span>
      <button type="button" onClick={onRetry} className="inline-flex items-center gap-1.5 rounded-lg border border-danger/40 px-3 py-1.5 font-medium hover:bg-danger/10">
        <RefreshCw className="h-3.5 w-3.5" /> {t('privacyCenter.retry')}
      </button>
    </div>
  );
}

export function PrivacyCenter() {
  const t = useTranslations();
  const { role, members, userEmail } = useApp();
  const { success, error: toastError } = useToast();
  const manager = isManager(role);

  const nameOf = (actorId: string | null) => members.find((m) => m.id === actorId)?.display_name ?? t('privacyCenter.unknownActor');

  // ── access log (last 50) + recent exports, from the same ledger ────────────
  const [audit, setAudit] = useState<Loaded<{ recent: AuditRow[]; exports: AuditRow[] }>>({ status: 'loading' });
  const [auditKey, setAuditKey] = useState(0);
  useEffect(() => {
    if (!manager) { setAudit({ status: 'ok', data: { recent: [], exports: [] } }); return; }
    let active = true;
    setAudit({ status: 'loading' });
    (async () => {
      const supabase = createClient();
      const columns = 'id, actor_kind, actor_id, domain, capability, decision, reason, created_at';
      // Two reads on purpose: a busy ledger can push the last export past the
      // 50-row window, and "No exports yet" would then be a false statement.
      const [recentRes, exportsRes] = await Promise.all([
        supabase.from('trust_audit_logs').select(columns).order('created_at', { ascending: false }).limit(50),
        supabase.from('trust_audit_logs').select(columns).eq('domain', 'privacy').eq('capability', 'export').order('created_at', { ascending: false }).limit(10),
      ]);
      if (!active) return;
      if (recentRes.error || exportsRes.error) {
        console.error('[privacy-center] access log read failed', recentRes.error ?? exportsRes.error);
        setAudit({ status: 'error' });
        return;
      }
      setAudit({ status: 'ok', data: { recent: (recentRes.data ?? []) as AuditRow[], exports: (exportsRes.data ?? []) as AuditRow[] } });
    })();
    return () => { active = false; };
  }, [manager, auditKey]);

  // ── this device's session ──────────────────────────────────────────────────
  const [session, setSession] = useState<Loaded<{ lastSignInAt: string | null; assurance: Assurance }>>({ status: 'loading' });
  const [sessionKey, setSessionKey] = useState(0);
  useEffect(() => {
    let active = true;
    setSession({ status: 'loading' });
    (async () => {
      const supabase = createClient();
      const [userRes, aalRes] = await Promise.all([supabase.auth.getUser(), supabase.auth.mfa.getAuthenticatorAssuranceLevel()]);
      if (!active) return;
      const error = userRes.error ?? aalRes.error;
      if (error || !userRes.data.user || !aalRes.data) {
        console.error('[privacy-center] session read failed', error ?? new Error('empty response'));
        setSession({ status: 'error' });
        return;
      }
      setSession({
        status: 'ok',
        data: {
          lastSignInAt: userRes.data.user.last_sign_in_at ?? null,
          assurance: { currentLevel: aalRes.data.currentLevel, nextLevel: aalRes.data.nextLevel },
        },
      });
    })();
    return () => { active = false; };
  }, [sessionKey]);

  // ── export ─────────────────────────────────────────────────────────────────
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  async function downloadExport() {
    if (exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch('/api/privacy/export', { method: 'GET', headers: { Accept: 'application/json' } });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; failed?: string[]; stepUp?: string };
        if (res.status === 403 && body.error === 'step_up_required' && body.stepUp) {
          toastError(t('privacyCenter.exportStepUp'));
          window.location.assign(body.stepUp);
          return;
        }
        if (res.status === 429) { setExportError(t('privacyCenter.exportRateLimited')); return; }
        if (body.error === 'audit_failed') { setExportError(t('privacyCenter.exportAuditFailed')); return; }
        if (body.error === 'export_failed' && body.failed?.length) {
          setExportError(t('privacyCenter.exportFailed', { sections: body.failed.join(', ') }));
          return;
        }
        setExportError(t('privacyCenter.exportFailedGeneric'));
        return;
      }
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'bubaly-export.json';
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      success(t('privacyCenter.exportDone'));
      // The ledger has a new row now; show it.
      setAuditKey((k) => k + 1);
    } catch (err) {
      console.error('[privacy-center] export request failed', err);
      setExportError(t('privacyCenter.exportFailedGeneric'));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div id="privacy" className="scroll-mt-20 space-y-4">
      <Card>
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand-text"><FileJson className="h-5 w-5" /></div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{t('privacyCenter.title')}</h2>
            <p className="mt-0.5 text-sm text-muted">{t('privacyCenter.description')}</p>
          </div>
        </div>

        <div className="mt-5 rounded-2xl border border-border bg-surface/40 p-4">
          <h3 className="text-sm font-semibold">{t('privacyCenter.exportTitle')}</h3>
          <p className="mt-1 text-xs text-muted">{t('privacyCenter.exportHelp')}</p>
          {exportError && (
            <div className="mt-3"><RetryNotice message={exportError} onRetry={downloadExport} /></div>
          )}
          <div className="mt-3">
            <Button size="sm" onClick={downloadExport} loading={exporting} disabled={exporting}>
              <Download className="h-4 w-4" /> {exporting ? t('privacyCenter.exporting') : t('privacyCenter.exportButton')}
            </Button>
          </div>

          <h4 className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">{t('privacyCenter.recentExports')}</h4>
          <p className="mt-1 text-xs text-muted">{t('privacyCenter.recentExportsHelp')}</p>
          {!manager ? (
            <p className="mt-2 text-xs text-muted">{t('privacyCenter.managersOnly')}</p>
          ) : audit.status === 'loading' ? (
            <p className="mt-2 text-xs text-muted">{t('privacyCenter.loading')}</p>
          ) : audit.status === 'error' ? (
            <div className="mt-2"><RetryNotice message={t('privacyCenter.couldNotLoadExports')} onRetry={() => setAuditKey((k) => k + 1)} /></div>
          ) : audit.data.exports.length === 0 ? (
            <p className="mt-2 text-xs text-muted">{t('privacyCenter.noExportsYet')}</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {audit.data.exports.map((r) => (
                <li key={r.id} className="flex items-center gap-2 text-xs">
                  <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  <span className="text-muted">{fmtDateTime(r.created_at)}</span>
                  <span>·</span>
                  <span className="font-medium">{nameOf(r.actor_id)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card>
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand-text"><History className="h-5 w-5" /></div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold">{t('privacyCenter.accessTitle')}</h3>
            <p className="mt-0.5 text-xs text-muted">{t('privacyCenter.accessHelp')}</p>
          </div>
        </div>
        <div className="mt-4">
          {!manager ? (
            <p className="text-xs text-muted">{t('privacyCenter.managersOnly')}</p>
          ) : audit.status === 'loading' ? (
            <p className="text-xs text-muted">{t('privacyCenter.loading')}</p>
          ) : audit.status === 'error' ? (
            <RetryNotice message={t('privacyCenter.couldNotLoadAccess')} onRetry={() => setAuditKey((k) => k + 1)} />
          ) : audit.data.recent.length === 0 ? (
            <p className="text-xs text-muted">{t('privacyCenter.noAccessYet')}</p>
          ) : (
            <ul className="max-h-96 space-y-2 overflow-y-auto">
              {audit.data.recent.map((r) => (
                <li key={r.id} className="rounded-xl border border-border bg-surface/40 px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-semibold capitalize">{r.decision.replace(/_/g, ' ')}</span>
                    {r.domain && <span className="rounded-md bg-elevated px-1.5 py-0.5 text-[11px] text-muted">{r.domain}{r.capability ? ` · ${r.capability}` : ''}</span>}
                    <span className="ml-auto text-muted">{fmtDateTime(r.created_at)}</span>
                  </div>
                  <p className="mt-1 text-muted">
                    <span className="font-medium text-fg">{r.actor_kind === 'ai_agent' ? t('privacyCenter.actorBubaly') : nameOf(r.actor_id)}</span>
                    {r.reason ? ` — ${r.reason}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card>
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand-text"><MonitorSmartphone className="h-5 w-5" /></div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold">{t('privacyCenter.sessionsTitle')}</h3>
            <p className="mt-0.5 text-xs text-muted">{t('privacyCenter.sessionsHelp')}</p>
          </div>
        </div>
        <div className="mt-4">
          {session.status === 'loading' ? (
            <p className="text-xs text-muted">{t('privacyCenter.loading')}</p>
          ) : session.status === 'error' ? (
            <RetryNotice message={t('privacyCenter.couldNotLoadSession')} onRetry={() => setSessionKey((k) => k + 1)} />
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t('privacyCenter.thisDevice')}</p>
                <p className="text-xs text-muted">{t('privacyCenter.signedInAs', { email: userEmail ?? '' })}</p>
                {session.data.lastSignInAt && <p className="text-xs text-muted">{t('privacyCenter.lastSignIn', { when: fmtDateTime(session.data.lastSignInAt) })}</p>}
                <p className="text-xs text-muted">
                  {sessionStrength(session.data.assurance) === 'stepped_up' ? t('privacyCenter.sessionAal2') : t('privacyCenter.sessionAal1')}
                </p>
              </div>
              <form action="/auth/signout" method="post">
                <Button type="submit" size="sm" variant="outline">{t('privacyCenter.signOutThisDevice')}</Button>
              </form>
            </div>
          )}
        </div>
      </Card>

      <Card className="border-danger/30">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-danger/10 text-danger"><Trash2 className="h-5 w-5" /></div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold">{t('privacyCenter.deletionTitle')}</h3>
            <p className="mt-0.5 text-xs text-muted">{t('privacyCenter.deletionHelp')}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link href="/feedback" className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border px-3 text-sm font-medium hover:bg-elevated">
                {t('privacyCenter.requestDeletion')}
              </Link>
              <Link href="/dashboard/billing" className="inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-sm text-muted hover:text-fg">
                {t('privacyCenter.closeInstead')}
              </Link>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Sparkles, Save, CalendarClock, Send, Loader2, AlertTriangle, CheckCircle2,
} from 'lucide-react';
import { PROVIDERS, PLATFORMS, type SocialPlatform } from '@/lib/social/capabilities';
import {
  POST_KINDS, charsRemaining, validateForPlatform, ASPECT_GUIDANCE, type PostKind,
} from '@/lib/social/content';
import { AI_GENERATION_KINDS, AI_KIND_LABELS, type AiGenerationKind } from '@/lib/social/ai-kinds';
import { createPostAction, type CreatePostResult } from '@/app/(app)/dashboard/social/actions';
import { PlatformDot } from './platform';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useTranslations } from '@/components/i18n/locale-provider';

type AccountLite = { id: string; platform: SocialPlatform; display_name: string | null; handle: string | null; status: string };

export function StudioForm({ accounts }: { accounts: AccountLite[] }) {
  const tr = useTranslations();
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [link, setLink] = useState('');
  const [kind, setKind] = useState<PostKind>('text');
  const [selectedPlatforms, setSelectedPlatforms] = useState<SocialPlatform[]>([]);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [scheduledFor, setScheduledFor] = useState('');
  const [pending, setPending] = useState(false);
  const submission = useRef<'idle' | 'pending' | 'review'>('idle');
  const [result, setResult] = useState<CreatePostResult | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const locked = pending || Boolean(result?.postId) || unconfirmed;

  // AI panel
  const [aiKind, setAiKind] = useState<AiGenerationKind>('caption');
  const [aiTopic, setAiTopic] = useState('');
  const [aiTone, setAiTone] = useState('friendly');
  const [aiPlatform, setAiPlatform] = useState<SocialPlatform | ''>('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiOutput, setAiOutput] = useState('');
  const [aiError, setAiError] = useState('');

  const togglePlatform = (p: SocialPlatform) =>
    setSelectedPlatforms((s) => (s.includes(p) ? s.filter((x) => x !== p) : [...s, p]));
  const toggleAccount = (id: string) =>
    setSelectedAccounts((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const issues = useMemo(
    () =>
      selectedPlatforms.flatMap((p) =>
        validateForPlatform(
          { kind, body, link, imageCount: 0, hasVideo: kind === 'video' || kind === 'short', isPoll: kind === 'poll' },
          p,
        ),
      ),
    [selectedPlatforms, kind, body, link],
  );
  const hasErrors = issues.some((i) => i.severity === 'error');

  async function runAi() {
    setAiBusy(true);
    setAiError('');
    setAiOutput('');
    try {
      const res = await fetch('/api/social/ai', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: aiKind, topic: aiTopic, tone: aiTone, platform: aiPlatform || null, source: body || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAiError(data.error ?? 'AI generation failed');
      } else {
        setAiOutput(data.text ?? '');
      }
    } catch {
      setAiError('Network error contacting AI service.');
    } finally {
      setAiBusy(false);
    }
  }

  async function submit(intent: 'draft' | 'schedule' | 'publish') {
    // A second create uses a new post ID and cannot share the server's existing
    // publish claim. Keep this guard synchronous, including queued callbacks.
    if (submission.current !== 'idle') return;
    submission.current = 'pending';
    setPending(true);
    setResult(null);
    const fd = new FormData();
    fd.set('intent', intent);
    fd.set('title', title);
    fd.set('body', body);
    fd.set('link', link);
    fd.set('kind', kind);
    fd.set('scheduled_for', scheduledFor);
    selectedPlatforms.forEach((p) => fd.append('platforms', p));
    selectedAccounts.forEach((a) => fd.append('account_ids', a));
    try {
      const r = await createPostAction(fd);
      submission.current = r.postId ? 'review' : 'idle';
      setResult(r);
      if (r.ok && intent === 'draft' && r.postId) router.push(`/dashboard/social/posts/${r.postId}`);
    } catch {
      // A lost action response may follow a durable create or provider send.
      // Preserve the draft, but require review instead of creating it again.
      submission.current = 'review';
      setUnconfirmed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {/* Editor */}
      <div className="space-y-4 lg:col-span-2">
        <Card>
          <label className="mb-1 block text-xs font-medium text-muted">{tr('studio.draftTitleInternal')}</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={tr('studio.springBreakRecap')}
            className="mb-3 w-full rounded-xl border border-border bg-elevated px-3 py-2 text-sm focus-ring"
          />

          <div className="mb-3 flex flex-wrap gap-2">
            {(POST_KINDS as PostKind[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={`rounded-lg border px-2.5 py-1 text-xs font-medium capitalize transition ${
                  kind === k ? 'border-brand bg-brand/15 text-brand-text' : 'border-border text-muted hover:text-fg'
                }`}
              >
                {k}
              </button>
            ))}
          </div>

          <label className="mb-1 block text-xs font-medium text-muted">{tr('studio.captionBody')}</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            placeholder={tr('studio.writeYourPostUseHashtagsAnd')}
            className="w-full resize-y rounded-xl border border-border bg-elevated px-3 py-2 text-sm focus-ring"
          />
          <label className="mb-1 mt-3 block text-xs font-medium text-muted">{tr('studio.linkOptional')}</label>
          <input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://…"
            className="w-full rounded-xl border border-border bg-elevated px-3 py-2 text-sm focus-ring"
          />
        </Card>

        {/* Per-platform previews + counters */}
        {selectedPlatforms.length > 0 && (
          <Card>
            <h3 className="mb-3 text-sm font-semibold">{tr('studio.perPlatformPreview')}</h3>
            <div className="space-y-3">
              {selectedPlatforms.map((p) => {
                const remaining = charsRemaining(body, p);
                const def = PROVIDERS[p];
                return (
                  <div key={p} className="rounded-xl border border-border p-3">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="inline-flex items-center gap-2 text-sm font-medium">
                        <PlatformDot platform={p} /> {def.label}
                      </span>
                      <span className={`text-xs ${remaining < 0 ? 'text-danger' : 'text-muted'}`}>
                        {remaining} left
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-muted">{body || 'Nothing yet…'}</p>
                    <p className="mt-1 text-[11px] text-muted">{ASPECT_GUIDANCE[p]}</p>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        {/* Validation */}
        {issues.length > 0 && (
          <Card>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <AlertTriangle className="h-4 w-4 text-warning" /> {tr('studio.validation')}
            </h3>
            <ul className="space-y-1 text-sm">
              {issues.map((i, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <Badge tone={i.severity === 'error' ? 'danger' : 'warning'}>{i.severity}</Badge>
                  <span className="text-muted">{i.message}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {/* Result */}
        {result && (
          <Card>
            {result.ok ? (
              <div className="space-y-2">
                <p className={`flex items-center gap-2 text-sm font-medium ${result.outcome?.status === 'publishing' ? 'text-warning' : 'text-success'}`}>
                  {result.outcome?.status === 'publishing' ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                  {result.action === 'publish' ? 'Publish attempted' : result.action === 'schedule' ? 'Scheduled' : 'Draft saved'}
                </p>
                {result.outcome && (
                  <ul className="space-y-1 text-sm">
                    {result.outcome.targets.map((t) => (
                      <li key={t.targetId} className="flex items-center gap-2">
                        <PlatformDot platform={t.platform} />
                        <Badge tone={t.status === 'published' ? 'success' : t.status === 'failed' ? 'danger' : 'neutral'}>
                          {t.status}
                        </Badge>
                        <span className="text-xs text-muted">{t.permalinkUrl ?? t.errorMessage}</span>
                      </li>
                    ))}
                    {result.outcome.targets.length === 0 && (
                      <li className="text-xs text-muted">{tr('studio.noPublishTargetsSelectedPickConnected')}</li>
                    )}
                  </ul>
                )}
              </div>
            ) : (
              <p className="flex items-center gap-2 text-sm text-danger">
                <AlertTriangle className="h-4 w-4" /> {result.error}
              </p>
            )}
            {result.postId && (
              <div className="mt-3 space-y-2 text-sm">
                <p className="text-muted">{tr(result.action === 'publish' || !result.ok ? 'socialStudio.reviewRequired' : 'socialStudio.savedPost')}</p>
                <Link href={`/dashboard/social/posts/${result.postId}`} className="text-brand-text underline">{tr('socialStudio.reviewPost')}</Link>
              </div>
            )}
          </Card>
        )}
        {unconfirmed && (
          <Card>
            <p role="alert" className="text-sm text-warning">{tr('socialStudio.requestUnconfirmed')}</p>
            <Link href="/dashboard/social/posts" className="mt-2 inline-block text-sm text-brand-text underline">{tr('socialStudio.reviewPosts')}</Link>
          </Card>
        )}
      </div>

      {/* Side: targets, AI, actions */}
      <div className="space-y-4">
        <Card>
          <h3 className="mb-2 text-sm font-semibold">{tr('studio.targetPlatforms')}</h3>
          <div className="flex flex-wrap gap-2">
            {PLATFORMS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => togglePlatform(p)}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs transition ${
                  selectedPlatforms.includes(p) ? 'border-brand bg-brand/15' : 'border-border'
                }`}
              >
                <PlatformDot platform={p} /> {PROVIDERS[p].label}
              </button>
            ))}
          </div>
        </Card>

        <Card>
          <h3 className="mb-2 text-sm font-semibold">{tr('studio.publishToAccounts')}</h3>
          {accounts.length === 0 ? (
            <p className="text-xs text-muted">
              {tr('studio.noConnectedAccountsYouCanStill')}
            </p>
          ) : (
            <div className="space-y-1.5">
              {accounts.map((a) => (
                <label key={a.id} className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5 text-sm">
                  <input type="checkbox" checked={selectedAccounts.includes(a.id)} onChange={() => toggleAccount(a.id)} />
                  <PlatformDot platform={a.platform} />
                  <span className="truncate">{a.display_name ?? a.handle ?? PROVIDERS[a.platform].label}</span>
                  <Badge tone={a.status === 'connected' ? 'success' : 'neutral'} className="ml-auto">{a.status}</Badge>
                </label>
              ))}
            </div>
          )}
        </Card>

        {/* AI assistant */}
        <Card>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4 text-brand-text" /> {tr('studio.aiAssistant')}
          </h3>
          <select value={aiKind} onChange={(e) => setAiKind(e.target.value as AiGenerationKind)} className="mb-2 w-full rounded-lg border border-border bg-elevated px-2 py-1.5 text-sm">
            {AI_GENERATION_KINDS.map((k) => <option key={k} value={k}>{AI_KIND_LABELS[k]}</option>)}
          </select>
          <input value={aiTopic} onChange={(e) => setAiTopic(e.target.value)} placeholder={tr('studio.topicOrInstruction')} className="mb-2 w-full rounded-lg border border-border bg-elevated px-2 py-1.5 text-sm" />
          <div className="mb-2 flex gap-2">
            <input value={aiTone} onChange={(e) => setAiTone(e.target.value)} placeholder={tr('studio.tone')} className="w-1/2 rounded-lg border border-border bg-elevated px-2 py-1.5 text-sm" />
            <select value={aiPlatform} onChange={(e) => setAiPlatform(e.target.value as SocialPlatform | '')} className="w-1/2 rounded-lg border border-border bg-elevated px-2 py-1.5 text-sm">
              <option value="">{tr('studio.anyPlatform')}</option>
              {PLATFORMS.map((p) => <option key={p} value={p}>{PROVIDERS[p].label}</option>)}
            </select>
          </div>
          <button type="button" onClick={runAi} disabled={aiBusy} className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-brand text-sm font-medium text-brand-fg disabled:opacity-60">
            {aiBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} {tr('studio.generate')}
          </button>
          {aiError && <p className="mt-2 text-xs text-danger">{aiError}</p>}
          {aiOutput && (
            <div className="mt-2 space-y-2">
              <p className="whitespace-pre-wrap rounded-lg border border-border bg-elevated p-2 text-xs">{aiOutput}</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => setBody(aiOutput)} className="flex-1 rounded-lg border border-border px-2 py-1 text-xs hover:bg-elevated">Use</button>
                <button type="button" onClick={() => setBody((b) => (b ? b + '\n\n' + aiOutput : aiOutput))} className="flex-1 rounded-lg border border-border px-2 py-1 text-xs hover:bg-elevated">{tr('studio.append')}</button>
              </div>
            </div>
          )}
        </Card>

        {/* Actions */}
        <Card>
          <label className="mb-1 block text-xs font-medium text-muted">{tr('studio.scheduleFor')}</label>
          <input
            type="datetime-local"
            value={scheduledFor}
            onChange={(e) => setScheduledFor(e.target.value)}
            className="mb-3 w-full rounded-lg border border-border bg-elevated px-2 py-1.5 text-sm"
          />
          <div className="space-y-2">
            <button type="button" disabled={locked} onClick={() => submit('draft')} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-border text-sm font-medium hover:bg-elevated disabled:opacity-60">
              <Save className="h-4 w-4" /> {tr('studio.saveDraft')}
            </button>
            <button type="button" disabled={locked || !scheduledFor} onClick={() => submit('schedule')} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-elevated text-sm font-medium hover:bg-elevated/70 disabled:opacity-50">
              <CalendarClock className="h-4 w-4" /> {tr('studio.schedule')}
            </button>
            <button type="button" disabled={locked || hasErrors || selectedAccounts.length === 0} onClick={() => submit('publish')} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-brand text-sm font-medium text-brand-fg shadow-glow disabled:opacity-50">
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} {tr('studio.publishNow')}
            </button>
            {hasErrors && <p className="text-center text-[11px] text-danger">{tr('studio.resolveValidationErrorsToPublish')}</p>}
            {!hasErrors && selectedAccounts.length === 0 && <p className="text-center text-[11px] text-muted">{tr('studio.selectAtLeastOneAccountTo')}</p>}
          </div>
        </Card>
      </div>
    </div>
  );
}

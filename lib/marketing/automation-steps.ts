import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { getResend, FROM_EMAIL, emailEnabled, APP_URL } from '@/lib/email';
import type { Copy } from '@/lib/marketing/automation-triggers';
import { unsubUrl } from '@/lib/marketing/unsubscribe';
import { canonicalMailbox } from '@/lib/server/canonical-mailbox';
import { escapeLike } from '@/lib/supabase/escape-like';

type DB = SupabaseClient<Database>;

export type Step = { action: string; subject?: string; body?: string };
export type Recipient = { email: string | null; name?: string | null };
/** Asked once per mail, just before it is sent: may one more go to this recipient? */
export type SendAdmission = () => Promise<boolean>;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}

/**
 * Whether this address may be sent automation mail, from the same ledger the
 * campaign sender reads (lib/marketing/send.ts): an unsubscribe, a bounce and a
 * complaint each leave a row in `marketing_suppressions`.
 *
 * Automation used to skip it. Anyone who had opted out kept getting workflow
 * mail — and the form_submitted trigger is reachable anonymously, so a stranger
 * could aim it at an address that had asked us to stop. A read that fails is
 * `unknown`, never `mailable`: an opt-out we could not read is still an opt-out.
 *
 * The opt-out is looked up under the address as typed AND its canonical inbox
 * (lib/server/canonical-mailbox.ts). A public form takes any spelling, so
 * `victim+day1@gmail.com` would otherwise reach the inbox that unsubscribed as
 * `victim@gmail.com`, once a day, a new `+tag` each time.
 *
 * That only helps when the ledger holds the inbox. /api/marketing/unsubscribe
 * now records it beside the spelling that was mailed, but a row written before
 * it did holds ONLY that spelling — `victim+news@gmail.com` — and neither
 * `victim@gmail.com` nor `victim+other@gmail.com` names it. So when the exact
 * read finds nothing, a second read takes every stored spelling that could be
 * the same inbox (a LIKE that is a superset) and keeps those whose canonical
 * inbox IS this one. No row is rewritten: the old rows are honoured as they are.
 * A superset too large to read whole is `unknown`, never `mailable`.
 */
async function suppressionFor(supabase: DB, email: string): Promise<'mailable' | 'suppressed' | 'unknown'> {
  try {
    const typed = email.trim().toLowerCase();
    const inbox = canonicalMailbox(typed);
    const { data, error } = await supabase
      .from('marketing_suppressions')
      .select('email')
      .in('email', [...new Set([typed, inbox])])
      .limit(1);
    if (error || !Array.isArray(data)) return 'unknown';
    if (data.length > 0) return 'suppressed';

    const parts = inboxParts(inbox);
    if (!parts) return 'mailable';
    // Every stored spelling whose canonical inbox is `inbox` matches (and some
    // that are not; the comparison below is exact). Outside Gmail a spelling
    // differs from its inbox by a `+tag` on the local part or a trailing dot on
    // the domain (canonicalMailbox folds both, and older unsubscribes stored
    // either as typed), so the scan takes the local part as a prefix, not only
    // `local+…`. Gmail also ignores dots anywhere in the local part and answers
    // to googlemail.com. The address's own LIKE metacharacters go through the
    // shared escapeLike (lib/supabase/escape-like.ts), except a star: PostgREST
    // turns every `*` in a like value into `%` before PostgreSQL sees it,
    // backslash or not, so escapeLike's `\*` arrives as `\%` and matches a
    // literal percent sign, never the star. A star is therefore sent as `_` (any
    // one character), which keeps the scan a superset; the exact comparison
    // below drops the neighbours it lets in.
    const spellings = supabase.from('marketing_suppressions').select('email');
    const { data: near, error: nearError } = await (parts.gmail
      ? spellings.like('email', `${[...parts.local].map((char) => escapeLike(char).replace('\\*', '_')).join('%')}%@g%mail.com%`)
      : spellings.like('email', `${escapeLike(parts.local).replaceAll('\\*', '_')}%@${escapeLike(parts.domain).replaceAll('\\*', '_')}%`)
    ).limit(SPELLING_SCAN_LIMIT);
    if (nearError || !Array.isArray(near)) return 'unknown';
    if (near.some((row) => typeof row.email === 'string' && canonicalMailbox(row.email) === inbox)) return 'suppressed';
    return near.length < SPELLING_SCAN_LIMIT ? 'mailable' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Rows the spelling read takes before it stops trusting that it saw them all. */
const SPELLING_SCAN_LIMIT = 500;

/** An inbox's local part and domain, and whether Gmail's spelling rules apply. */
function inboxParts(inbox: string): { local: string; domain: string; gmail: boolean } | null {
  const at = inbox.lastIndexOf('@');
  if (at <= 0) return null;
  const domain = inbox.slice(at + 1);
  return { local: inbox.slice(0, at), domain, gmail: domain === 'gmail.com' };
}

/** The signed one-click way out every automation mail carries, as campaign mail does. */
function unsubscribeFooter(url: string): string {
  return `<hr style="margin-top:32px;border:none;border-top:1px solid #e5e7eb" /><p style="color:#9ca3af;font-size:12px;line-height:18px;margin-top:16px">Don't want emails like this from Bubaly? <a href="${url}" style="color:#6b7280">Unsubscribe</a>.</p>`;
}

/**
 * The per-step results an earlier attempt of a run recorded in its metadata
 * (`{ actions: [...] }`), or none. A failed run is retried by running its steps
 * again, and this is how the retry knows which of them already went out.
 */
export function recordedActions(metadata: unknown): string[] {
  const actions = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as { actions?: unknown }).actions
    : undefined;
  return Array.isArray(actions) ? actions.map((action) => (typeof action === 'string' ? action : '')) : [];
}

/**
 * A run's recorded results exactly as stored (`metadata.actions`), as JSON
 * text, or null when it holds none: what a retry's claim is fenced on.
 *
 * The receipts are read before the run is claimed. Another pass can claim the
 * run in between, deliver an email, fail a later step and record that
 * delivery; a retry that then claimed the run worked from receipts without
 * it, and sent the email again. Claimed only while `metadata.actions` is still
 * what was read, the claim matches nothing in that case, and the run waits,
 * failed, for a pass that reads its receipts afresh. The fence is on the
 * results alone, not the whole metadata: they are short, and every attempt
 * that records them records its steps (`retryOf`) in the same write.
 */
export function recordedActionsJson(metadata: unknown): string | null {
  const actions = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as { actions?: unknown }).actions
    : undefined;
  return actions === undefined || actions === null ? null : JSON.stringify(actions);
}

/**
 * Whether a run's metadata carries the steps an attempt ran (`retryOf`). A
 * retry that read a run without them is claimed only while it still has none:
 * another pass may have retried it in between, recording the same results
 * (a carried send, the same step failing again) beside the steps IT ran, and
 * a claim fenced on the results alone then matched, and retried from the stale
 * read against the current steps — an edited workflow's — sending again what
 * the other pass had already delivered. Once recorded, the steps are the
 * snapshot every later retry runs and records again, so their presence is the
 * whole fence.
 */
export function stepsRecorded(metadata: unknown): boolean {
  const steps = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as { steps?: unknown }).steps
    : undefined;
  return steps !== undefined && steps !== null;
}

/**
 * What a retry of a failed run works from: the steps its earlier attempt ran,
 * and what each of them did (`recordedActions`), matched by position.
 *
 * Positions only line up against the steps that attempt RAN. The workflow
 * can be edited between attempts, and a retry used to load its CURRENT
 * steps: "email A, email B" recorded as [sent, failed] and then reordered to
 * "email B, email A" skipped B as sent and mailed A a second time. So every
 * attempt records the steps it ran beside their results (`metadata.steps`),
 * and a retry runs that snapshot. An edit to the workflow reaches runs that
 * start after it. A run recorded before attempts kept their steps has no
 * snapshot, and is matched against the current steps as before.
 */
export function retryOf(metadata: unknown, current: Step[]): { steps: Step[]; previous: string[] } {
  const recorded = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as { steps?: unknown }).steps
    : undefined;
  // A recorded snapshot is run as it was recorded, entries runSteps could not
  // read included: it records each of those as a failed step, so the next
  // attempt meets it at the same index. Falling back to the current steps for
  // such a snapshot paired them with receipts made against other steps — a
  // first run of [email A, null] recorded [send_email, step:failed], and with
  // the workflow edited to [null, email A] the retry sent A again at the
  // failed index.
  const snapshot = Array.isArray(recorded) ? (recorded as Step[]) : null;
  return { steps: snapshot ?? current, previous: recordedActions(metadata) };
}

/** Emails this attempt actually sent: a send carried over from `previous` was not sent again. */
export function emailsSent(actions: readonly string[], previous: readonly string[] = []): number {
  return actions.filter((action, i) => action === 'send_email' && previous[i] !== 'send_email').length;
}

/**
 * The log to record when an attempt failed without producing one of its own
 * (the caller caught a throw from `runSteps`). Writing a bare
 * `['automation:failed']` there erased the only record of which emails had
 * already gone, so the next retry sent them again. This keeps every send the
 * earlier attempt recorded, by position, and marks the rest failed, so the run
 * stays failed and the retry repeats nothing that was delivered.
 */
export function failedAttempt(steps: readonly unknown[], previous: readonly string[] = []): string[] {
  if (steps.length === 0) return ['automation:failed'];
  return steps.map((_, i) => (previous[i] === 'send_email' ? 'send_email' : 'automation:failed'));
}

/**
 * Executes a workflow's steps for one recipient. Only `send_email` actually
 * sends today (via Resend); other actions (notify_admin / apply_tag /
 * add_to_segment / update_lead_score …) are recorded but not yet executed.
 * Returns a per-step result log for the run's metadata. Shared by both the
 * scheduled runner and the event-driven dispatcher so behaviour stays identical.
 *
 * A suppressed recipient is recorded as `send_email:suppressed`, which is NOT a
 * failure: the run did what it should, and a failed run is re-claimed by the
 * scheduled runner on every tick, which would re-read the opt-out forever.
 *
 * `admit`, when given, is asked immediately before each mail is handed to the
 * provider — after the opt-out read, so a suppressed recipient spends nothing —
 * and a refusal is recorded as `send_email:throttled`, also not a failure (the
 * bound held). It is how a caller's per-recipient allowance is enforced on the
 * mail actually sent rather than on the event that started it: one event fans
 * out to every matching workflow and every send_email step in each.
 *
 * `previous` is the log of the earlier attempt when a failed run is retried.
 * A `send_email` step it records as sent is carried over and NOT sent again:
 * every step but `send_email` is recorded `:unsupported`, which fails the run,
 * so a workflow such as "send_email, then apply_tag" is retried on every pass
 * and used to mail the same person the same email each time. A failed, skipped,
 * suppressed, throttled or never-attempted send is still attempted, opt-out
 * read and admission included. Steps are matched by position.
 *
 * A step that throws (a malformed workflow, such as a body that is not text)
 * is recorded `<action>:failed` and the rest still run. It used to escape, and
 * the caller then replaced the whole log, sends included, with one failure.
 */
export async function runSteps(
  steps: Step[],
  recipient: Recipient,
  fallback: Copy,
  supabase: DB,
  admit?: SendAdmission,
  previous: readonly string[] = [],
): Promise<string[]> {
  const done: string[] = [];
  for (const [i, step] of steps.entries()) {
    try {
      if (step.action === 'send_email' && previous[i] === 'send_email') {
        done.push('send_email');
        continue;
      }
      if (step.action === 'send_email' && !recipient.email) {
        done.push('send_email:skipped(no-recipient)');
        continue;
      }
      if (step.action === 'send_email' && recipient.email) {
        // Read the opt-out for EVERY send, never once per run: an unsubscribe that
        // lands while an earlier step's mail is in flight must stop the next one.
        const consent = await suppressionFor(supabase, recipient.email);
        if (consent === 'unknown') {
          done.push('send_email:failed');
          continue;
        }
        if (consent === 'suppressed') {
          done.push('send_email:suppressed');
          continue;
        }
        const subject = step.subject || fallback.subject;
        const html = `<p>Hi ${escapeHtml(recipient.name || 'there')},</p><p>${escapeHtml(step.body || fallback.body)}</p><p>— The Bubaly Team</p>`;
        if (emailEnabled()) {
          // A refusal, and an admission that could not be decided, both send nothing.
          let admitted = true;
          if (admit) {
            try { admitted = await admit(); } catch { admitted = false; }
          }
          if (!admitted) {
            done.push('send_email:throttled');
            continue;
          }
          // The admission is awaited, and an opt-out can land while it is. Read
          // the opt-out again right before the provider is called. (The first
          // read stays, so an inbox already opted out never spends its allowance.)
          if (admit) {
            const now = await suppressionFor(supabase, recipient.email);
            if (now !== 'mailable') {
              done.push(now === 'suppressed' ? 'send_email:suppressed' : 'send_email:failed');
              continue;
            }
          }
          try {
            const unsubscribe = unsubUrl(APP_URL, recipient.email);
            const { error } = await getResend().emails.send({
              from: FROM_EMAIL,
              to: recipient.email,
              subject,
              html: `${html}${unsubscribeFooter(unsubscribe)}`,
              headers: { 'List-Unsubscribe': `<${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
            });
            done.push(error ? 'send_email:failed' : 'send_email');
          } catch (error) {
            console.error('[marketing automation] email provider call failed', error);
            done.push('send_email:failed');
          }
        } else {
          done.push('send_email:skipped(no-key)');
        }
      } else {
        done.push(`${step.action}:unsupported`);
      }
    } catch (error) {
      console.error('[marketing automation] step threw', error);
      done.push(`${typeof step?.action === 'string' ? step.action : 'step'}:failed`);
    }
  }
  return done;
}

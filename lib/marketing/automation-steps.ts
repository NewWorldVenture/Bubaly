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
    // differs from its inbox only by a `+tag`; Gmail also ignores dots anywhere
    // in the local part and answers to googlemail.com. The address's own LIKE
    // metacharacters go through the shared escapeLike (lib/supabase/escape-like.ts).
    const spellings = supabase.from('marketing_suppressions').select('email');
    const { data: near, error: nearError } = await (parts.gmail
      ? spellings.like('email', `${[...parts.local].map((char) => escapeLike(char)).join('%')}%@g%mail.com%`)
      : spellings.like('email', `${escapeLike(parts.local)}+%@${escapeLike(parts.domain)}%`)
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
 */
export async function runSteps(
  steps: Step[],
  recipient: Recipient,
  fallback: Copy,
  supabase: DB,
  admit?: SendAdmission,
): Promise<string[]> {
  const done: string[] = [];
  let consent: 'mailable' | 'suppressed' | 'unknown' | null = null;
  for (const step of steps) {
    if (step.action === 'send_email' && !recipient.email) {
      done.push('send_email:skipped(no-recipient)');
      continue;
    }
    if (step.action === 'send_email' && recipient.email) {
      consent ??= await suppressionFor(supabase, recipient.email);
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
  }
  return done;
}

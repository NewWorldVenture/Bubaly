import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { getResend, FROM_EMAIL, emailEnabled, APP_URL } from '@/lib/email';
import type { Copy } from '@/lib/marketing/automation-triggers';
import { unsubUrl } from '@/lib/marketing/unsubscribe';

type DB = SupabaseClient<Database>;

export type Step = { action: string; subject?: string; body?: string };
export type Recipient = { email: string | null; name?: string | null };

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
 */
async function suppressionFor(supabase: DB, email: string): Promise<'mailable' | 'suppressed' | 'unknown'> {
  try {
    const { data, error } = await supabase
      .from('marketing_suppressions')
      .select('email')
      .eq('email', email.trim().toLowerCase())
      .limit(1);
    if (error || !Array.isArray(data)) return 'unknown';
    return data.length > 0 ? 'suppressed' : 'mailable';
  } catch {
    return 'unknown';
  }
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
 */
export async function runSteps(steps: Step[], recipient: Recipient, fallback: Copy, supabase: DB): Promise<string[]> {
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

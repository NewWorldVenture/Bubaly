import type { SupabaseBrowser } from '@/lib/supabase/types';
import { describeActionError } from '@/lib/supabase/errors';

import { FEEDBACK_ATTACHMENTS_BUCKET } from './feedback-attachment-url';

export { FEEDBACK_ATTACHMENTS_BUCKET, feedbackAttachmentPathFromUrl } from './feedback-attachment-url';
export const FEEDBACK_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export async function removeFeedbackAttachmentPath(
  supabase: SupabaseBrowser,
  path: string,
): Promise<{ error: string | null }> {
  const { error } = await supabase.storage.from(FEEDBACK_ATTACHMENTS_BUCKET).remove([path]);
  return { error: error ? describeActionError(error) : null };
}

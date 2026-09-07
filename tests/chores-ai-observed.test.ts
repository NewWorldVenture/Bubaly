// A child does their chore, submits a photo, and waits for a parent.
//
// `validateChoreSubmission` never throws. It ends at `fallbackValidation` four
// different ways, and from the child's side those four are ONE thing: the chore
// was not auto-approved and now needs a grown-up. Two of the four are silent
// failures — the model answered something unusable, or the provider threw — and
// until §33 nothing recorded either.
//
// The other two are not failures at all, and this file's sharpest assertion is
// that they open NO row: "no API key configured" is a setting, and "a photo
// chore with no photo" is a guard that fires before anything is asked of a
// model. Counting those as AI failures would make the failure count on
// /admin/ai-activity useless, which is the number support looks at first.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getProvider: vi.fn(), complete: vi.fn(), createRequest: vi.fn(), updateRequest: vi.fn(), recordModelCall: vi.fn() }));
vi.mock('@/lib/ai/provider', () => ({ getProvider: mocks.getProvider }));
vi.mock('@/lib/ai/runs/store', () => ({ createRequest: mocks.createRequest, updateRequest: mocks.updateRequest }));
vi.mock('@/lib/ai/usage', () => ({ recordModelCall: mocks.recordModelCall }));

import { validateChoreSubmission } from '@/lib/chores/ai';
import type { ServiceScope } from '@/lib/services/types';

const scope = {
  db: {} as never, familyId: 'fam-1', userId: 'user-1', memberId: 'mem-1',
  role: 'parent', actorKind: 'member', tz: 'America/Chicago',
} as ServiceScope;

const submission = {
  choreTitle: 'Empty the dishwasher',
  proofKind: 'photo' as const,
  kidNote: 'all done!',
  images: [{ url: 'data:image/png;base64,x' }] as never,
};

/** What the observability wrapper wrote, in order. */
function opened() { return mocks.createRequest.mock.calls.map(([, input]) => input as { feature?: string }); }
function settledStatuses() { return mocks.updateRequest.mock.calls.map(([, , patch]) => (patch as { status?: string }).status); }

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPENAI_API_KEY = 'test-key-not-a-real-secret';
  mocks.getProvider.mockReturnValue({ model: 'test-model', complete: mocks.complete });
  mocks.createRequest.mockResolvedValue({ ok: true, data: { id: 'req-1' } });
  mocks.updateRequest.mockResolvedValue({ ok: true, data: {} });
  mocks.recordModelCall.mockResolvedValue(undefined);
});
afterEach(() => { delete process.env.OPENAI_API_KEY; });

describe('a chore submission that reaches the model', () => {
  it('records a usable verdict as completed', async () => {
    mocks.complete.mockResolvedValue({
      text: JSON.stringify({ status: 'approved', quality_score: 90, kid_feedback: 'Nice work', needs_parent_review: false }),
      usage: { promptTokens: 40, completionTokens: 10 },
    });
    const verdict = await validateChoreSubmission(scope, submission);
    expect(verdict.status).toBe('approved');
    expect(opened().map((i) => i.feature)).toEqual(['chores.validate']);
    expect(settledStatuses()).toContain('completed');
  });

  it('records an unparseable verdict as a failure, and still sends the child to a parent', async () => {
    // The model answered — the tokens are spent — and the reply is prose where
    // JSON was asked for. The child's outcome is the same as an outage; the row
    // is the only place those differ.
    mocks.complete.mockResolvedValue({ text: 'Looks good to me!', usage: { promptTokens: 40, completionTokens: 6 } });
    const verdict = await validateChoreSubmission(scope, submission);
    expect(verdict.status).toBe('parent_review_required');
    expect(settledStatuses()).toContain('failed');
    // The spend is on the row even though the turn failed.
    expect(mocks.recordModelCall).toHaveBeenCalledWith(expect.objectContaining({ model: 'test-model', ok: false }));
  });

  it('records a provider outage as a failure, and never rejects the child for it', async () => {
    mocks.complete.mockRejectedValue(new Error('upstream 503'));
    const verdict = await validateChoreSubmission(scope, submission);
    // Never `rejected`: a kid must not be penalised for an AI outage.
    expect(verdict.status).toBe('parent_review_required');
    expect(settledStatuses()).toContain('failed');
  });
});

describe('the two paths that are not AI failures open no row at all', () => {
  it('opens nothing when no API key is configured', async () => {
    delete process.env.OPENAI_API_KEY;
    const verdict = await validateChoreSubmission(scope, submission);
    expect(verdict.status).toBe('parent_review_required');
    expect(mocks.createRequest).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('opens nothing when a photo chore arrives with no photo', async () => {
    // A guard, not an outage. Nothing was asked of a model, so nothing is owed
    // to the ledger — and a row here would inflate the failure count that
    // support reads as "how much AI is broken right now".
    const verdict = await validateChoreSubmission(scope, { ...submission, images: [] as never });
    expect(verdict.status).toBe('parent_review_required');
    expect(mocks.createRequest).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});

describe('bookkeeping never costs a child their verdict', () => {
  it('still returns the verdict when the request row cannot be opened', async () => {
    // The wrapper's central promise. A family losing a chore approval because an
    // observability insert failed would be the gap making itself worse.
    mocks.createRequest.mockRejectedValue(new Error('ledger down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.complete.mockResolvedValue({
      text: JSON.stringify({ status: 'approved', quality_score: 88, needs_parent_review: false }),
      usage: null,
    });
    const verdict = await validateChoreSubmission(scope, submission);
    expect(verdict.status).toBe('approved');
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { guardianEscalationEventId, guardianEscalationSchema } from '@/lib/guardian/escalation';

const root = process.cwd();

describe('Guardian emergency escalation boundary', () => {
  it('validates family, communication, severity, type, and bounded description fields', () => {
    const valid = {
      familyId: '00000000-0000-4000-8000-000000000001',
      commId: '00000000-0000-4000-8000-000000000002',
      escalationType: 'emergency_call',
      severity: 'critical',
      description: 'Emergency call requires immediate attention.',
    } as const;
    expect(guardianEscalationSchema.safeParse(valid).success).toBe(true);
    expect(guardianEscalationSchema.safeParse({ ...valid, familyId: 'not-a-uuid' }).success).toBe(false);
    expect(guardianEscalationSchema.safeParse({ ...valid, description: 'x'.repeat(4097) }).success).toBe(false);
    expect(guardianEscalationSchema.safeParse({ ...valid, escalationType: 'other' }).success).toBe(false);
    expect(guardianEscalationEventId(valid)).toBe(guardianEscalationEventId({ ...valid }));
    expect(guardianEscalationEventId(valid)).toBe(guardianEscalationEventId({ ...valid, description: 'Updated description' }));
    const withoutCommunication = { ...valid, commId: undefined };
    expect(guardianEscalationEventId(withoutCommunication)).not.toBe(guardianEscalationEventId({ ...withoutCommunication, severity: 'high' }));
  });

  it('claims before telephony side effects and resolves parent phones through user_id', () => {
    const source = readFileSync(resolve(root, 'app/api/guardian/escalate/route.ts'), 'utf8');
    expect(source).toContain('claimGuardianCallback');
    expect(source).toContain('markGuardianCallbackError');
    expect(source).toContain('markGuardianCallbackProcessed');
    expect(source).toContain(".select('id, user_id, display_name, role')");
    expect(source).toContain(".in('id', userIds)");
    expect(source).toContain('phoneMap.get(m.user_id)');
    expect(source.indexOf('await claimGuardianCallback')).toBeLessThan(source.indexOf('sendSms('));
    expect(source.indexOf('await claimGuardianCallback')).toBeLessThan(source.indexOf('initiateCall('));
  });
});

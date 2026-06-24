import { describe, expect, it } from 'vitest';
import { analyzeDocuments, buildDocumentsPrompt, parseDocumentsResponse, type DocumentForAI } from '@/lib/documents/documents-ai';

function doc(overrides: Partial<DocumentForAI> = {}): DocumentForAI {
  return { title: 'Passport', category: 'identity', expires_at: null, ...overrides };
}

describe('analyzeDocuments', () => {
  it('summarizes documents', () => {
    const r = analyzeDocuments([doc(), doc({ category: 'medical' })]);
    expect(r.totalDocuments).toBe(2);
    expect(Object.keys(r.categoryCounts)).toHaveLength(2);
  });

  it('detects expiring docs', () => {
    const soon = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();
    const r = analyzeDocuments([doc({ expires_at: soon })]);
    expect(r.expiringCount).toBe(1);
  });

  it('handles empty', () => {
    const r = analyzeDocuments([]);
    expect(r.totalDocuments).toBe(0);
    expect(r.summary).toContain('No documents');
  });
});

describe('buildDocumentsPrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildDocumentsPrompt([doc()]);
    expect(system).toContain('JSON');
    expect(user).toContain('Passport');
  });
});

describe('parseDocumentsResponse', () => {
  it('parses valid JSON', () => {
    const r = parseDocumentsResponse('{"suggestions":["scan originals"],"organizationTips":["use folders"],"securityTip":"encrypt sensitive docs"}');
    expect(r.suggestions).toEqual(['scan originals']);
    expect(r.securityTip).toBe('encrypt sensitive docs');
  });

  it('handles malformed', () => {
    expect(parseDocumentsResponse('bad').suggestions).toEqual([]);
  });
});

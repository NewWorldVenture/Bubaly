import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import type { Page, Request, Response } from '@playwright/test';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { describePhotoRead, familyPhotoRowCount, observeFamilyPhotoUpload } from './e2e/helpers/family-photo-diagnostics';

const ORIGIN = 'http://127.0.0.1:54321';
const PRIVATE = 'SYNTHETIC_PRIVATE_CANARY';
const PRIVATE_URL = `${ORIGIN}/storage/v1/object/family-media/${PRIVATE}/photo.png?token=${PRIVATE}`;
const EVENTS = ['request', 'response', 'requestfinished', 'requestfailed'];
const helperSource = readFileSync(new URL('./e2e/helpers/family-photo-diagnostics.ts', import.meta.url), 'utf8');
type Observer = typeof observeFamilyPhotoUpload;

function fixture(observe: Observer = observeFamilyPhotoUpload) {
  const emitter = new EventEmitter();
  const records: object[] = [];
  const page = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => emitter.on(event, handler)),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => emitter.off(event, handler)),
  };
  const log = vi.fn((record: object) => records.push(record));
  let now = 100;
  const clock = vi.fn(() => now);
  const diagnostics = observe(page as unknown as Page, ORIGIN, log, clock);
  return { emitter, page, records, log, clock, diagnostics, advance: (value: number) => { now += value; } };
}

function request(url = PRIVATE_URL, method = 'POST') {
  const forbidden = () => { throw new Error('Private request accessor must not be read'); };
  return {
    url: vi.fn(() => url), method: vi.fn(() => method),
    headers: vi.fn(forbidden), allHeaders: vi.fn(forbidden), postData: vi.fn(forbidden),
    failure: vi.fn(forbidden), frame: vi.fn(forbidden),
  };
}

function response(item: ReturnType<typeof request>, status: unknown) {
  return {
    request: () => item as unknown as Request, status: () => status,
    url: vi.fn(() => { throw new Error('Private response accessor must not be read'); }),
    headers: vi.fn(() => { throw new Error('Private response accessor must not be read'); }),
    body: vi.fn(() => { throw new Error('Private response accessor must not be read'); }),
  } as unknown as Response;
}

function last(h: ReturnType<typeof fixture>) {
  h.diagnostics.report('body-failed');
  return JSON.parse(JSON.stringify(h.records.at(-1)));
}

function expectPrivateAccessorsUnread(item: ReturnType<typeof request>) {
  for (const accessor of [item.headers, item.allHeaders, item.postData, item.failure, item.frame]) expect(accessor).not.toHaveBeenCalled();
}

describe('family photo read evidence', () => {
  it.each([
    ['empty', { data: [], error: null, status: 200 }, 0],
    ['one', { data: [{ storage_path: PRIVATE_URL }], error: null, status: 200 }, 1],
    ['duplicate', { data: [{}, {}], error: null }, 2],
    ['error with no data', { data: null, error: { message: PRIVATE, code: PRIVATE }, status: 503 }, null],
    ['error with one row', { data: [{}], error: { message: PRIVATE, code: PRIVATE }, status: 403 }, null],
    ['error with empty rows', { data: [], error: PRIVATE }, null],
    ['null data without error', { data: null, error: null }, null],
    ['missing data', { error: null }, null],
    ['malformed data', { data: { length: 1, content: PRIVATE }, error: null }, null],
    ['null reply', null, null],
    ['undefined reply', undefined, null],
    ['array reply', [{}], null],
    ['string reply', PRIVATE, null],
  ])('distinguishes %s without turning failed observations into healthy rows', (_name, value, count) => {
    expect(familyPhotoRowCount(value)).toBe(count);
    expect(JSON.stringify(describePhotoRead(value))).not.toContain(PRIVATE);
  });

  it('records only error-code presence without reading the code/message/details', () => {
    const forbidden = vi.fn(() => { throw new Error(PRIVATE); });
    const error = Object.defineProperties({}, { code: { get: forbidden }, message: { get: forbidden }, details: { get: forbidden } });
    expect(describePhotoRead({ data: null, error, status: 403 })).toEqual({
      valid: false, errorPresent: true, errorCodePresent: true, rowCount: null, status: 403,
    });
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('fails closed on an unreadable result shape', () => {
    const value = Object.defineProperty({}, 'data', { get: () => { throw new Error(PRIVATE); } });
    expect(familyPhotoRowCount(value)).toBeNull();
    expect(JSON.stringify(describePhotoRead(value))).not.toContain(PRIVATE);
  });

  it.each([0, 99, 600, NaN, Infinity, 200.5, PRIVATE])('does not serialize malformed status %s', status => {
    expect(describePhotoRead({ data: [], error: null, status }).status).toBeNull();
  });

  it('observes empty-to-one recovery once per requested read with no extra reads', async () => {
    const h = fixture();
    const empty = { data: [], error: null }, one = { data: [{ storage_path: PRIVATE_URL }], error: null };
    const query = vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce(one);
    expect(await h.diagnostics.read(query)).toBe(empty);
    expect(familyPhotoRowCount(await h.diagnostics.read(query))).toBe(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(last(h).reads).toEqual({ started: 2, completed: 2, rejected: 0, errorResults: 0, malformedResults: 0, empty: 1, one: 1, multiple: 0, pending: 0 });
    h.diagnostics.dispose();
  });

  it('does not retry persistent empty, returned-error, malformed or duplicate results', async () => {
    const h = fixture();
    const replies = [{ data: [], error: null }, { data: [], error: null }, { data: [{}], error: { code: PRIVATE } }, { data: null }, { data: [{}, {}] }];
    for (const reply of replies) {
      const query = vi.fn().mockResolvedValue(reply);
      expect(await h.diagnostics.read(query)).toBe(reply);
      expect(query).toHaveBeenCalledTimes(1);
    }
    expect(last(h).reads).toMatchObject({ started: 5, completed: 5, empty: 2, errorResults: 1, malformedResults: 1, multiple: 1, one: 0 });
    h.diagnostics.dispose();
  });

  it('records an in-flight read, then the same rejection without copying the error', async () => {
    const h = fixture();
    let reject!: (reason: unknown) => void;
    const failure = new Error(PRIVATE);
    const query = vi.fn(() => new Promise<never>((_resolve, no) => { reject = no; }));
    const pending = h.diagnostics.read(query);
    const assertion = expect(pending).rejects.toBe(failure);
    expect(last(h).reads).toMatchObject({ started: 1, completed: 0, rejected: 0, pending: 1 });
    reject(failure);
    await assertion;
    expect(last(h).reads).toMatchObject({ started: 1, completed: 0, rejected: 1, pending: 0 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.records)).not.toContain(PRIVATE);
    h.diagnostics.dispose();
  });
});

describe('passive photo upload observations', () => {
  it('separates storage, insert and compensation using static labels and numeric receipts only', () => {
    const h = fixture();
    const upload = request(), insert = request(`${ORIGIN}/rest/v1/family_photos?select=id&family_id=${PRIVATE}`);
    const compensation = request(`${ORIGIN}/storage/v1/object/family-media`, 'DELETE');
    for (const [item, status] of [[upload, 200], [insert, 403], [compensation, 200]] as const) {
      h.emitter.emit('request', item);
      h.emitter.emit('response', response(item, status));
      h.emitter.emit('requestfinished', item);
      expectPrivateAccessorsUnread(item);
    }
    h.advance(25);
    const record = last(h);
    expect(record.requests).toEqual({
      'storage-upload': { started: 1, responses: 1, lastStatus: 200, finished: 1, failed: 0 },
      'photo-insert': { started: 1, responses: 1, lastStatus: 403, finished: 1, failed: 0 },
      'storage-compensation': { started: 1, responses: 1, lastStatus: 200, finished: 1, failed: 0 },
    });
    expect(record.elapsedMs).toBe(25);
    expect(record.outstanding).toBe(0);
    expect(JSON.stringify(record)).not.toMatch(/SYNTHETIC_PRIVATE_CANARY|https?:|authorization|cookie|storage_path|message|stack/);
    expect(Object.keys(record).sort()).toEqual(['phase', 'elapsedMs', 'trackingLimit', 'outstanding', 'overflow', 'observationFailures', 'requests', 'reads', 'lastRead'].sort());
    h.diagnostics.dispose();
  });

  it.each(['refused', 'failed', 'pending'])('distinguishes a %s upload from a row insert', mode => {
    const h = fixture(), item = request();
    h.emitter.emit('request', item);
    if (mode === 'refused') { h.emitter.emit('response', response(item, 403)); h.emitter.emit('requestfinished', item); }
    if (mode === 'failed') h.emitter.emit('requestfailed', item);
    const record = last(h);
    expect(record.requests['photo-insert'].started).toBe(0);
    expect(record.requests['storage-upload']).toMatchObject({ started: 1, lastStatus: mode === 'refused' ? 403 : null, failed: mode === 'failed' ? 1 : 0 });
    expect(record.outstanding).toBe(mode === 'pending' ? 1 : 0);
    expectPrivateAccessorsUnread(item);
    h.diagnostics.dispose();
  });

  it('ignores reads, signing, foreign origins and deceptive endpoint names', () => {
    const h = fixture();
    for (const item of [request(PRIVATE_URL, 'GET'), request(`${ORIGIN}/rest/v1/family_photos`, 'GET'),
      request(`${ORIGIN}/storage/v1/object/sign/family-media/${PRIVATE}`), request(`${ORIGIN}/rest/v1/family_photos_extra`),
      request(`http://other.invalid/storage/v1/object/family-media/${PRIVATE}`), request(`http://user:pass@127.0.0.1:54321/rest/v1/family_photos`)]) h.emitter.emit('request', item);
    expect(last(h).outstanding).toBe(0);
    expect(last(h).requests['storage-upload'].started).toBe(0);
    expect(last(h).requests['photo-insert'].started).toBe(0);
    h.diagnostics.dispose();
  });

  it('does not count duplicate request/response/completion events twice', () => {
    const h = fixture(), item = request();
    for (let i = 0; i < 2; i++) h.emitter.emit('request', item);
    for (let i = 0; i < 2; i++) h.emitter.emit('response', response(item, 200));
    h.emitter.emit('requestfinished', item);
    h.emitter.emit('requestfailed', item);
    h.emitter.emit('request', item);
    expect(last(h).requests['storage-upload']).toEqual({ started: 1, responses: 1, lastStatus: 200, finished: 1, failed: 0 });
    expect(last(h).outstanding).toBe(0);
    h.diagnostics.dispose();
  });

  it('bounds outstanding tracking and admits subsequent requests after completion', () => {
    const h = fixture(), items = Array.from({ length: 40 }, () => request());
    items.forEach(item => h.emitter.emit('request', item));
    expect(last(h)).toMatchObject({ trackingLimit: 32, outstanding: 32, overflow: 8 });
    h.emitter.emit('requestfinished', items[0]);
    h.emitter.emit('request', request());
    expect(last(h)).toMatchObject({ outstanding: 32, overflow: 8 });
    h.diagnostics.dispose();
  });

  it('detaches all listeners once and stops late reporting', () => {
    const h = fixture();
    for (const event of EVENTS) expect(h.emitter.listenerCount(event)).toBe(1);
    h.diagnostics.dispose();
    h.diagnostics.dispose();
    for (const event of EVENTS) expect(h.emitter.listenerCount(event)).toBe(0);
    expect(h.page.off).toHaveBeenCalledTimes(4);
    h.diagnostics.report('body-failed');
    expect(h.log).not.toHaveBeenCalled();
  });

  it('allows no caller-supplied phase label or retained mutable diagnostic object', () => {
    const h = fixture();
    h.diagnostics.report(PRIVATE as never);
    expect(h.log).not.toHaveBeenCalled();
    const first = last(h);
    expect(first.requests['storage-upload'].started).toBe(0);
    const emitted = h.records.at(-1) as { requests: { 'storage-upload': { started: number } } };
    emitted.requests['storage-upload'].started = 999;
    expect(last(h).requests['storage-upload'].started).toBe(0);
    h.diagnostics.dispose();
  });

  it.each(['logger', 'clock', 'listener', 'status', 'disposal'])('diagnostic %s failure cannot change the original read result/rejection', async fault => {
    const h = fixture(), item = request();
    const faulting = () => { throw new Error(PRIVATE); };
    if (fault === 'logger') h.log.mockImplementation(faulting);
    if (fault === 'clock') h.clock.mockImplementation(faulting);
    if (fault === 'listener') item.url.mockImplementation(faulting);
    if (fault === 'disposal') h.page.off.mockImplementation((event, handler) => { h.emitter.off(event, handler); return faulting(); });
    const observed = response(item, 200);
    if (fault === 'status') observed.status = faulting;
    expect(() => { h.emitter.emit('request', item); h.emitter.emit('response', observed); }).not.toThrow();
    const result = { data: [], error: null }, failure = new Error(PRIVATE);
    expect(await h.diagnostics.read(() => Promise.resolve(result))).toBe(result);
    await expect(h.diagnostics.read(() => Promise.reject(failure))).rejects.toBe(failure);
    expect(() => h.diagnostics.report('body-failed')).not.toThrow();
    expect(() => h.diagnostics.dispose()).not.toThrow();
    for (const event of EVENTS) expect(h.emitter.listenerCount(event)).toBe(0);
    expect(JSON.stringify(h.records)).not.toContain(PRIVATE);
  });

  it('removes partially registered listeners even when registration throws', () => {
    const emitter = new EventEmitter();
    const page = {
      on: (event: string, handler: (...args: unknown[]) => void) => { emitter.on(event, handler); throw new Error(PRIVATE); },
      off: (event: string, handler: (...args: unknown[]) => void) => emitter.off(event, handler),
    };
    const log = vi.fn();
    const h = observeFamilyPhotoUpload(page as unknown as Page, ORIGIN, log);
    h.report('body-failed');
    expect(log.mock.calls[0][0].observationFailures).toBe(4);
    h.dispose();
    for (const event of EVENTS) expect(emitter.listenerCount(event)).toBe(0);
  });

  it('does not cancel or adopt diagnostic results from a read that settles after disposal', async () => {
    const h = fixture();
    const result = { data: [{ storage_path: PRIVATE_URL }], error: null };
    let resolve!: (value: typeof result) => void;
    const query = vi.fn(() => new Promise<typeof result>(done => { resolve = done; }));
    const pending = h.diagnostics.read(query);
    h.diagnostics.dispose();
    resolve(result);
    expect(await pending).toBe(result);
    h.diagnostics.report('body-complete');
    expect(h.log).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });
});

function mutate(from: string, to: string) {
  expect(helperSource.split(from)).toHaveLength(2);
  const source = ts.transpileModule(helperSource.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, unknown> = {};
  runInNewContext(source, { exports, URL, performance, require: () => { throw new Error('No runtime imports are permitted'); } }, { timeout: 1000 });
  return exports as unknown as { familyPhotoRowCount: typeof familyPhotoRowCount; observeFamilyPhotoUpload: Observer };
}

describe('diagnostic negative controls', () => {
  it('detects accepting a row from a failed query', () => {
    const mutant = mutate('valid: !errorPresent && rowCount !== null', 'valid: rowCount !== null');
    expect(() => expect(mutant.familyPhotoRowCount({ data: [{}], error: { code: PRIVATE } })).toBeNull()).toThrow();
  });
  it('detects omitted observer disposal', () => {
    const mutant = mutate('for (const off of remove) ignoreDiagnosticFailure(off);', 'void remove;');
    const h = fixture(mutant.observeFamilyPhotoUpload);
    h.diagnostics.dispose();
    expect(() => { for (const event of EVENTS) expect(h.emitter.listenerCount(event)).toBe(0); }).toThrow();
    h.emitter.removeAllListeners();
  });
  it('detects retaining a raw error-code value', async () => {
    const mutant = mutate("typeof result.error === 'object' && 'code' in result.error", "typeof result.error === 'object' && (result.error as { code?: unknown }).code");
    const h = fixture(mutant.observeFamilyPhotoUpload);
    await h.diagnostics.read(() => Promise.resolve({ data: null, error: { code: PRIVATE } }));
    expect(() => expect(JSON.stringify(last(h))).not.toContain(PRIVATE)).toThrow();
    h.diagnostics.dispose();
  });
});

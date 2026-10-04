import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import {
  readBoundedRequestBytes, readBoundedRequestText, readBoundedRequestJson,
  readBoundedRequestJsonOrEmpty, readBoundedRequestFormData,
} from '@/lib/server/bounded-request-body';
const request = (body: BodyInit | null) => new Request('https://stream-fixture.invalid/ordinary', { method: 'POST', body, duplex: 'half' } as RequestInit);
test('locked unreadable body returns the declared refusal result', async () => {
  const req = request('ordinary');
  const lock = req.body!.getReader();
  try { assert.deepEqual(await readBoundedRequestBytes(req, 32), { ok: false, reason: 'unreadable' }); }
  finally { lock.releaseLock(); }
});
test('consumed unreadable JSON body returns the declared refusal result', async () => {
  const req = request('{"name":"ordinary"}');
  await req.text();
  assert.deepEqual(await readBoundedRequestJson(req, 32), { ok: false, reason: 'unreadable' });
});
test('healthy body bytes are preserved', async () => {
  assert.deepEqual(await readBoundedRequestBytes(request('ordinary'), 8), { ok: true, bytes: new TextEncoder().encode('ordinary') });
});
test('over-limit body remains refused', async () => {
  assert.deepEqual(await readBoundedRequestBytes(request('ordinary'), 7), { ok: false, reason: 'too_large' });
});
test('stream read error remains an unreadable refusal', async () => {
  const body = new ReadableStream({ start(controller) { controller.error(new TypeError('Synthetic unreadable stream')); } });
  assert.deepEqual(await readBoundedRequestBytes(request(body), 32), { ok: false, reason: 'unreadable' });
});
test('empty body remains valid', async () => {
  assert.deepEqual(await readBoundedRequestBytes(request(null), 0), { ok: true, bytes: new Uint8Array() });
});
const unreadableHelpers = [
  ['bytes', readBoundedRequestBytes, ['consumed']],
  ['text', readBoundedRequestText, ['locked', 'consumed']],
  ['json', readBoundedRequestJson, ['locked']],
  ['optional JSON', readBoundedRequestJsonOrEmpty, ['locked', 'consumed']],
  ['form', readBoundedRequestFormData, ['locked', 'consumed']],
] as const;
for (const [name, read, states] of unreadableHelpers) {
  for (const state of states) {
    test(`${name} preserves unreadable refusal for a ${state} body`, async () => {
      const req = request('ordinary');
      const lock = state === 'locked' ? req.body!.getReader() : null;
      if (state === 'consumed') await req.text();
      try { assert.deepEqual(await read(req, 32), { ok: false, reason: 'unreadable' }); }
      finally { lock?.releaseLock(); }
    });
  }
}

test('healthy bounded JSON is parsed', async () => {
  assert.deepEqual(await readBoundedRequestJson(request('{"name":"ordinary"}'), 32), { ok: true, value: { name: 'ordinary' } });
});
test('malformed JSON retains invalid_json refusal', async () => {
  assert.deepEqual(await readBoundedRequestJson(request('{'), 32), { ok: false, reason: 'invalid_json' });
});
test('optional malformed JSON retains its documented empty-object behavior', async () => {
  assert.deepEqual(await readBoundedRequestJsonOrEmpty(request('{'), 32), { ok: true, value: {} });
});
test('optional absent JSON retains its documented empty-object behavior', async () => {
  assert.deepEqual(await readBoundedRequestJsonOrEmpty(request(null), 0), { ok: true, value: {} });
});
test('healthy bounded ordinary form fields are preserved', async () => {
  const result = await readBoundedRequestFormData(request(new URLSearchParams({ name: 'ordinary' })), 32);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual([...result.value.entries()], [['name', 'ordinary']]);
});
test('an unsupported form content type retains invalid_form refusal', async () => {
  assert.deepEqual(await readBoundedRequestFormData(request('ordinary'), 32), { ok: false, reason: 'invalid_form' });
});
test('crossing the byte bound cancels before reading remaining chunks', async () => {
  let pulls = 0;
  let cancellations = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array([1, 2, 3]));
    },
    cancel() { cancellations += 1; },
  }, { highWaterMark: 0 });
  assert.deepEqual(await readBoundedRequestBytes(request(stream), 4), { ok: false, reason: 'too_large' });
  assert.equal(pulls, 2);
  assert.equal(cancellations, 1);
});
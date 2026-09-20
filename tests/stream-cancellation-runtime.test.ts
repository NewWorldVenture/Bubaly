import { setImmediate } from 'node:timers/promises';
import { createBufferedTransformStream } from 'next/dist/server/stream-utils/node-web-streams-helper';
import { describe, expect, it } from 'vitest';

// Node PR62040 fixes the internal error when client cancellation and a late
// SSR write interleave. Keep the installed Next helper in the runtime gate.
describe('supported web runtime stream cancellation', () => {
  it.each([
    ['native TransformStream', () => new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { controller.enqueue(chunk); } })],
    ['installed Next buffering transform', createBufferedTransformStream],
  ] as const)('%s rejects/finishes a late write without an internal controller error', async (_name, create) => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const stream = create();
      await setImmediate();
      const reader = stream.readable.getReader(), writer = stream.writable.getWriter();
      const results = await Promise.allSettled([
        reader.read(), reader.cancel(new Error('Synthetic client disconnect')), writer.write(new Uint8Array([1])),
      ]);
      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('fulfilled');
      if (results[2].status === 'rejected') {
        expect(String(results[2].reason)).not.toContain('transformAlgorithm is not a function');
      }
    }
  });
});

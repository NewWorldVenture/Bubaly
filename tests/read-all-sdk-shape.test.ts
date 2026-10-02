import { beforeEach, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { readAll, readAllAsQuery } from '@/lib/supabase/read-all';

// Actual SDK parsing, with a finite custom transport and no backend or Auth calls.
const family = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const row = { id: 'ordinary-item-A', family_id: family };
type RequestReceipt = { offset: number; limit: number; family: string | null };
let requests: RequestReceipt[], mode: string, selectedBody: unknown;
beforeEach(() => { requests = []; mode = 'healthy'; selectedBody = undefined; });

function page() {
  const db = createClient('https://synthetic-read-shape.invalid', 'synthetic-not-a-secret', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const u = new URL(String(input));
      expect(u.origin).toBe('https://synthetic-read-shape.invalid');
      expect(u.pathname).toBe('/rest/v1/inventory_items');
      expect(init?.method).toBe('GET');
      expect(u.searchParams.get('family_id')).toBe('eq.' + family);
      expect(u.searchParams.get('select')).toBe('id,family_id');
      expect(u.searchParams.get('order')).toBe('id.asc');
      const offset = Number(u.searchParams.get('offset') || 0);
      const limit = Number(u.searchParams.get('limit'));
      expect(limit).toBeGreaterThan(0);
      expect(limit).toBeLessThanOrEqual(4);
      requests.push({ offset, limit, family: u.searchParams.get('family_id') });
      expect(requests.length).toBeLessThanOrEqual(2);
      const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
        status, headers: { 'content-type': 'application/json' },
      });
      if (mode === 'object-zero') return reply({ length: 0 });
      if (mode === 'object-one') return reply({ length: 1 });
      if (mode === 'null') return reply(null);
      if (mode === 'read-error') return reply({ code: '42501', message: 'Synthetic ordinary read refused' }, 403);
      if (mode === 'empty') return reply([]);
      if (mode === 'second-error' && offset > 0) return reply({ code: '42501', message: 'Synthetic second ordinary page refused' }, 403);
      if (mode === 'body') return reply(offset === 0 ? selectedBody : []);
      if (mode === 'second-body' && offset > 0) return reply(selectedBody);
      if (mode === 'array-values') return reply(offset === 0 ? [null, 7, 'ordinary scalar'] : []);
      return reply(offset === 0 ? [row] : []);
    } },
  });
  return (from: number, to: number) => db.from('inventory_items')
    .select('id,family_id').eq('family_id', family).order('id').range(from, to);
}
function read(options = { max: 3 }) {
  return readAllAsQuery<typeof row>(page(), options);
}

it('an actual SDK200 object with length0 is refused instead of certified as completeempty',async()=>{mode='object-zero';const result=await read();expect(result.error).not.toBeNull();expect(result.data).toBeNull();expect(requests).toHaveLength(1);});
it('an actual SDK200 noniterable object is settled as refusal instead of rejecting',async()=>{mode='object-one';await expect(read()).resolves.toMatchObject({data:null,error:expect.anything()});expect(requests).toHaveLength(1);});
it('a healthy array followed by empty completes with exact scoped row and actual offsets',async()=>{const result=await read();expect(result).toEqual({data:[row],count:null,error:null,truncated:false});expect(requests).toEqual([{offset:0,limit:4,family:'eq.'+family},{offset:1,limit:3,family:'eq.'+family}]);});
it('a genuine empty array is a healthy completeempty result',async()=>{mode='empty';expect(await read()).toEqual({data:[],count:null,error:null,truncated:false});expect(requests).toHaveLength(1);});
it('a null SDK200 body is refused with data:null',async()=>{mode='null';const result=await read();expect(result.error).not.toBeNull();expect(result.data).toBeNull();expect(requests).toHaveLength(1);});
it('an explicit SDK read error is refused with data:null',async()=>{mode='read-error';const result=await read();expect(result.error).not.toBeNull();expect(result.data).toBeNull();expect(requests).toHaveLength(1);});
it('a later SDK page error discards the partial prefix instead of presenting it as complete',async()=>{mode='second-error';const result=await read();expect(result.error).not.toBeNull();expect(result.data).toBeNull();expect(requests).toHaveLength(2);});

// Keep the seven original complete assertion declarations above byte-for-byte.
// A collection response must be an array; these cases impose no row-type policy.
const malformedBodies = [
  { name: 'false', body: false },
  { name: 'true', body: true },
  { name: 'zero', body: 0 },
  { name: 'one', body: 1 },
  { name: 'empty string', body: '' },
  { name: 'one-character string', body: 'A' },
  { name: 'two-character string', body: 'AB' },
  { name: 'object without length', body: {} },
  { name: 'zero-length object', body: { length: 0 } },
  { name: 'one-length object', body: { length: 1 } },
  { name: 'indexed array-like object', body: { 0: row, length: 1 } },
  { name: 'string-length object', body: { length: '0' } },
];

it.each(malformedBodies)('refuses SDK200 $name as an unavailable first page', async ({ body }) => {
  mode = 'body'; selectedBody = body;
  const result = await read();
  expect(result).toEqual({ data: null, count: null, error: new Error('The data page was unavailable'), truncated: false });
  expect(result.error).toBeInstanceOf(Error);
  expect(requests).toEqual([{ offset: 0, limit: 4, family: 'eq.' + family }]);
});

it.each(malformedBodies)('discards the prefix when a later SDK200 page is $name', async ({ body }) => {
  mode = 'second-body'; selectedBody = body;
  const result = await read({ max: 1 });
  expect(result).toEqual({ data: null, count: null, error: new Error('The data page was unavailable'), truncated: false });
  expect(result.error).toBeInstanceOf(Error);
  expect(requests).toEqual([
    { offset: 0, limit: 2, family: 'eq.' + family },
    { offset: 1, limit: 1, family: 'eq.' + family },
  ]);
});

it('readAll retains already read rows while settling a malformed later SDK page', async () => {
  mode = 'second-body'; selectedBody = { length: 1 };
  const result = await readAll<typeof row>(page(), { max: 3 });
  expect(result).toEqual({ rows: [row], error: new Error('The data page was unavailable'), truncated: false });
  expect(result.error).toBeInstanceOf(Error);
  expect(requests).toEqual([
    { offset: 0, limit: 4, family: 'eq.' + family },
    { offset: 1, limit: 3, family: 'eq.' + family },
  ]);
});

it('preserves array contents without imposing a row-type policy', async () => {
  mode = 'array-values';
  expect(await read()).toEqual({ data: [null, 7, 'ordinary scalar'], count: null, error: null, truncated: false });
  expect(requests).toEqual([
    { offset: 0, limit: 4, family: 'eq.' + family },
    { offset: 3, limit: 1, family: 'eq.' + family },
  ]);
});

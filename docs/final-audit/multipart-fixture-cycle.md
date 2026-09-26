# TEST-003 — inbound multipart cancellation fixture

Root recorded TEST-003 before this test-only correction. Application limits and cancellation behavior are unchanged.

## Failure and actual cause

The fourth-cycle combined run under the isolated official Node 24.21.0 executable reported 12,995 passing tests, two unrelated stale static assertions, and an unhandled `ERR_INVALID_STATE: ReadableStream is already closed`. The error was attributed to the most recently active `caps combined attachment bytes and keeps sanitized filenames as metadata` test. Exact log: `C:/Users/Daniel/AppData/Local/Temp/bubaly-fourth-units-20260912.log`.

Isolating the two adjacent tests disproved that attribution:

```powershell
& 'C:/Users/Daniel/AppData/Local/Temp/bubaly-node24-perf002-20260912-v24.21.0/node.exe' node_modules/vitest/vitest.mjs run tests/email-attachments.test.ts --maxWorkers=1 -t 'bounds the whole multipart request'
& 'C:/Users/Daniel/AppData/Local/Temp/bubaly-node24-perf002-20260912-v24.21.0/node.exe' node_modules/vitest/vitest.mjs run tests/email-attachments.test.ts --maxWorkers=1 -t 'caps combined attachment bytes'
```

Before correction, the first command returned one passing assertion **plus one unhandled rejection and exit 1**. The second command passed cleanly. The whole attachment suite also reproduced the unhandled error independently of the full suite.

The fixture supplied a live `FormData` object directly to `NextRequest`. Node 24.21.0's bundled Undici `extractBody` starts an asynchronous multipart encoder without awaiting its promise (`node:internal/deps/undici/undici`, lines 6933–6947). Its loop checks whether the stream is errored, but cancellation closes the stream without marking it errored. After `readBoundedRequestBytes` correctly cancels an overbudget body, that encoder can enqueue into the closed controller at line 6940. This is distinct from PERF-002's TransformStream cancellation bug.

An incoming HTTP request reaches installed Next 15.5.25's `NextRequestAdapter.fromNodeNextRequest` as the Node request body stream, not as an active FormData encoder. A standalone loopback HTTP reproduction passed before the fixture correction: chunked multipart bytes → actual NodeNextRequest/NextRequestAdapter → actual bounded form reader produced `too_large`, returned HTTP 413 to the client, and exited without unhandled errors. The read-only temporary harness remains at `C:/Users/Daniel/AppData/Local/Temp/bubaly-undici-multipart-repro-20260912.cjs`.

## Correction and regression evidence

`tests/email-attachments.test.ts` now fully serializes its known fixture multipart data before presenting an inbound byte stream to the actual handler. The stream emits bounded 64 KiB chunks, supports cancellation, and has no content-length hint. The oversized test requires HTTP 413, exactly one cancellation, no more than one chunk beyond the configured limit read, an unread trailing body, no database queries, and no extraction calls.

An additional regression sends the serialized multipart bytes over loopback chunked HTTP and executes the installed Next request adapter and actual email POST handler. It asserts that no content length was supplied, HTTP 413 reaches the client, no handler error occurs, and no database/provider work starts. The loopback server is closed after each case. Existing attachment filing, retry, identity, size/count and metadata assertions remain intact.

```powershell
& 'C:/Users/Daniel/AppData/Local/Temp/bubaly-node24-perf002-20260912-v24.21.0/node.exe' node_modules/vitest/vitest.mjs run tests/email-attachments.test.ts tests/raw-body-boundaries.test.ts tests/stream-cancellation-runtime.test.ts --reporter=verbose --maxWorkers=1
```

**3 files / 30 tests PASS, zero unhandled errors, exit 0**, including 22 attachment cases, six raw-body boundaries and two actual native/Next runtime cancellation cases. Scoped ESLint and `git diff --check` pass.

No runtime/global error handler, dependency, production body reader, upload limit or provider behavior was changed. The platform's synthetic FormData cancellation defect remains outside this repository; the corrected fixture exercises the actual inbound transport contract. This bounded loopback proof does not claim verification of every hosted proxy or framework request path. Root owns the final combined runtime/type/build gates.

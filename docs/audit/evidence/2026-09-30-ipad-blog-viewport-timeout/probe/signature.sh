#!/bin/bash
# Real overflow spec, [ipad] /blog, retries 0. The gateway is paused before the
# test starts and resumed STALL s after Playwright launches (test start is ~2-3 s later).
P=<probe dir>
cd <repo>; export PATH=<node 24.21.0 bin>:$PATH
for PORT in 3128 3127; do for STALL in 28 30 32; do
  L=$P/sig-$PORT-$STALL.log
  docker pause supabase_kong_bubaly >/dev/null
  ( sleep $STALL; docker unpause supabase_kong_bubaly >/dev/null ) &
  env -u PW_CHROMIUM_PATH PLAYWRIGHT_BROWSERS_PATH=<playwright browsers, chromium-1228> PLAYWRIGHT_EXTERNAL_SERVER=1 PLAYWRIGHT_PORT=$PORT \
    npx playwright test tests/e2e/overflow.spec.ts --project=ipad -g '/blog fits every width' --retries=0 --reporter=line > $L 2>&1
  wait
  res=$(grep -E "^\s+[0-9]+ (passed|failed)" $L | tr -s ' ' | tr '\n' ' ')
  err=$(grep -m1 -E "Error: page\.[a-zA-Z]+|Test timeout" $L | sed 's/^ *//' | cut -c1-90)
  echo "port=$PORT ($( [ $PORT = 3128 ] && echo main || echo fix )) stall=${STALL}s: $res $err"
  sleep 2
done; done
docker unpause supabase_kong_bubaly >/dev/null 2>&1; true

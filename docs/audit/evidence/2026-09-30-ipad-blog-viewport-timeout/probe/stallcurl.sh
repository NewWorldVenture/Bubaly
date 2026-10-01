#!/bin/bash
docker pause supabase_kong_bubaly >/dev/null
for r in /blog /pricing / /faq; do echo "$r $(curl -s -m 100 -o /dev/null -w '%{http_code} ttfb=%{time_starttransfer}s total=%{time_total}s' http://localhost:3127$r)"; done
docker unpause supabase_kong_bubaly >/dev/null
echo "after unpause: /blog $(curl -s -m 30 -o /dev/null -w '%{http_code} %{time_starttransfer}s' http://localhost:3127/blog)"

#!/bin/bash
P=<probe dir>
TAG=$1; PAUSE=$2; RUN=$3; REPEAT=$4
cd <repo>; export PATH=<node 24.21.0 bin>:$PATH
rm -f $P/$TAG.jsonl; touch $P/$TAG.flag
$P/duty.sh $P/$TAG.flag $PAUSE $RUN &
env -u PW_CHROMIUM_PATH PLAYWRIGHT_BROWSERS_PATH=<playwright browsers, chromium-1228> PROBE_OUT=$P/$TAG.jsonl PROBE_ROUTES=/blog,/,/pricing PROBE_PROJECTS=ipad PROBE_RESULTS=<repo>-probe-results/$TAG npx playwright test -c $P/probe.config.ts --repeat-each=$REPEAT --workers=1 > $P/$TAG.log 2>&1
rm -f $P/$TAG.flag; wait
echo "== $TAG pause=$PAUSE run=$RUN"; grep -E "^\s+[0-9]+ (passed|failed)" $P/$TAG.log
grep -E "Error: (page\.[a-zA-Z]+|Test timeout)" $P/$TAG.log | sort | uniq -c
python3 $P/summarize.py $P/$TAG.jsonl 2>/dev/null

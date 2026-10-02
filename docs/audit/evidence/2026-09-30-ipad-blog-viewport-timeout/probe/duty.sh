#!/bin/bash
# Intermittent gateway stalls: paused PAUSE s, running RUN s, until the flag file is removed.
FLAG=$1; PAUSE=$2; RUN=$3
while [ -f "$FLAG" ]; do docker pause supabase_kong_bubaly >/dev/null 2>&1; sleep $PAUSE; docker unpause supabase_kong_bubaly >/dev/null 2>&1; sleep $RUN; done
docker unpause supabase_kong_bubaly >/dev/null 2>&1; true

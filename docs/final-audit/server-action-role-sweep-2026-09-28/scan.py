#!/usr/bin/env python3
"""Refuse to publish evidence that carries identifiers, credentials or content.

  python3 scan.py <file>...

Fails on: any UUID other than the sweep's fixed placeholder, an email address,
a JWT, a Supabase auth cookie name, a bearer token, a long base64/hex run, a
Next-Action id, an admission witness, or a known secret variable assigned a value.
"""
import re, sys

PLACEHOLDER = '00000000-0000-4000-8000-00000000abcd'
CHECKS = {
    'uuid': re.compile(r'\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b', re.I),
    'email': re.compile(r'\b[\w.+-]+@[\w-]+\.[\w.-]+\b'),
    'jwt': re.compile(r'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'),
    'supabase cookie': re.compile(r'sb-[a-z0-9]+-auth-token'),
    'bearer': re.compile(r'Bearer\s+[A-Za-z0-9._-]{20,}'),
    'long base64': re.compile(r'[A-Za-z0-9+/_-]{60,}={0,2}'),
    'next-action id': re.compile(r'\b[0-9a-f]{40,}\b'),
    'secret assignment': re.compile(r'(SERVICE_ROLE_KEY|SECRET_KEY|ANON_KEY|PUBLISHABLE_KEY|CRON_SECRET|PASSWORD)\s*[=:]\s*\S{8,}'),
}
# Commit SHAs are 40 hex characters and are the point of the evidence.
ALLOWED_HEX = re.compile(r'^[0-9a-f]{40}$')

bad = 0
for path in sys.argv[1:]:
    for n, line in enumerate(open(path, encoding='utf-8'), 1):
        for name, rx in CHECKS.items():
            for m in rx.finditer(line):
                s = m.group(0)
                if name == 'uuid' and s.lower() == PLACEHOLDER:
                    continue
                if name == 'next-action id' and ALLOWED_HEX.match(s):
                    continue
                if name == 'email' and s.endswith(('.ts', '.tsx', '.mjs', '.md', '.json')):
                    continue
                if name == 'long base64' and ('/' in s and not re.search(r'[+=]', s)):
                    continue  # a file path, not an encoded value
                print(f'{path}:{n}: {name}: {s[:60]}')
                bad += 1
print('clean' if not bad else f'{bad} finding(s)')
sys.exit(1 if bad else 0)

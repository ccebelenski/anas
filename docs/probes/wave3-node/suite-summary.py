#!/usr/bin/env python3
"""Wave-3 node pass: per-spec pass/fail/skip and the first error line of every
failure, from Playwright JSON reports. Usage: suite-summary.py <tag>=<report.json> …"""
import collections
import json
import re
import sys

for arg in sys.argv[1:]:
    tag, path = arg.split('=', 1)
    d = json.load(open(path))
    st = d['stats']
    print(f'=== {tag}: start {st["startTime"]} duration {st["duration"] / 1000:.0f}s '
          f'expected={st["expected"]} unexpected={st["unexpected"]} skipped={st["skipped"]} flaky={st["flaky"]}')
    per = collections.OrderedDict()
    fails = []

    def walk(s, f=None):
        f = s.get('file', f)
        for sp in s.get('specs', []):
            for t in sp['tests']:
                r = t['results'][-1] if t['results'] else None
                rs = r['status'] if r else 'notrun'
                per.setdefault(f, collections.Counter())[rs] += 1
                if rs not in ('passed', 'skipped'):
                    e = re.sub(r'\x1b\[[0-9;]*m', '', (r.get('error') or {}).get('message', ''))
                    fails.append((f, sp['line'], sp['title'][:90], e.split('\n')[0][:220]))
        for c in s.get('suites', []):
            walk(c, f)

    for s in d['suites']:
        walk(s)
    for f, c in per.items():
        print(f'  {f:48s} ' + ' '.join(f'{k}={v}' for k, v in sorted(c.items())))
    print('  -- failures:')
    for f, line, title, e in fails:
        print(f'  {f}:{line} {title}\n      {e}')

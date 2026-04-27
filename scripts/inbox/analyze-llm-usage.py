#!/usr/bin/env python3
"""Analyze /tmp/llm.log on the server."""
import json, re, sys
from collections import defaultdict

by_day = defaultdict(lambda: {"calls": 0, "in_tokens": 0, "out_tokens": 0, "cache_read": 0, "cost": 0.0})
no_usage = 0
for line in sys.stdin:
    m = re.search(r"\{.*\}", line)
    if not m:
        continue
    try:
        d = json.loads(m.group(0))
    except Exception:
        continue
    t = d.get("time", "")
    if not t:
        continue
    day = t[:10]
    by_day[day]["calls"] += 1
    if "inputTokens" in d:
        by_day[day]["in_tokens"] += d.get("inputTokens", 0)
        by_day[day]["out_tokens"] += d.get("outputTokens", 0)
        by_day[day]["cache_read"] += d.get("cacheReadTokens", 0)
        by_day[day]["cost"] += d.get("costUsd", 0.0)
    else:
        no_usage += 1

total_calls = sum(d["calls"] for d in by_day.values())
print(f"Total calls in log: {total_calls}")
print(f"Calls without usage data: {no_usage}")
print()
print(f"{'Day':12} {'Calls':>6} {'OutTok':>10} {'CacheRd':>12} {'Cost':>10}")
for day in sorted(by_day.keys()):
    s = by_day[day]
    print(f"{day:12} {s['calls']:>6} {s['out_tokens']:>10,} {s['cache_read']:>12,} ${s['cost']:>9.2f}")

recent = [day for day in sorted(by_day.keys()) if day >= "2026-04-21"]
if recent:
    days = len(recent)
    total = {"calls": 0, "in_tokens": 0, "out_tokens": 0, "cache_read": 0, "cost": 0.0}
    for d in recent:
        for k in total:
            total[k] += by_day[d][k]
    print()
    print(f"Last {days} days totals:")
    print(f"  calls:                {total['calls']:>10}")
    print(f"  output tokens:        {total['out_tokens']:>10,}")
    print(f"  cache read tokens:    {total['cache_read']:>10,}")
    print(f"  cost (API equiv):     ${total['cost']:>9.2f}")
    print(f"  per day avg:          {total['calls']/days:>5.0f} calls, "
          f"{total['out_tokens']/days:>8,.0f} out tok, ${total['cost']/days:>5.2f}")

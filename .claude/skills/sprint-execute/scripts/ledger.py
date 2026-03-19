#!/usr/bin/env python3
"""Sprint ledger — track sprint status in a TSV file.

Usage: ledger.py [-d DIR] <command> [args]

Commands:
  stats                  Show overview
  list [--status S]      List sprints
  next                   Show next planned
  add <id> <title>       Add sprint (status=planned)
  start <id>             Mark in_progress
  complete <id>          Mark completed
  sync                   Sync from SPRINT-*.md files
"""
import re, sys
from datetime import datetime, timezone
from pathlib import Path

HEADER = "sprint_id\ttitle\tstatus\tupdated_at"
STATUSES = ("planned", "in_progress", "completed", "skipped")

def load(path):
    rows = {}
    if path.exists():
        for line in path.read_text().splitlines()[1:]:
            if line.strip():
                sid, title, status, ts = line.split("\t")
                rows[sid] = {"id": sid, "title": title, "status": status, "ts": ts}
    return rows

def save(path, rows):
    lines = [HEADER] + ["\t".join([r["id"], r["title"], r["status"], r["ts"]])
                         for r in sorted(rows.values(), key=lambda r: r["id"])]
    path.write_text("\n".join(lines) + "\n")

def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def main():
    args = sys.argv[1:]
    d = Path("docs/sprints")
    if args[:2] and args[0] == "-d":
        d = Path(args[1]); args = args[2:]
    tsv = d / "ledger.tsv"
    rows = load(tsv)
    cmd = args[0] if args else "stats"

    if cmd == "stats":
        counts = {s: sum(1 for r in rows.values() if r["status"] == s) for s in STATUSES}
        print(f"Sprints: {len(rows)}  " + "  ".join(f"{s}={n}" for s, n in counts.items() if n))
        nxt = next((r for r in sorted(rows.values(), key=lambda r: r["id"]) if r["status"] == "planned"), None)
        if nxt: print(f"Next: {nxt['id']} - {nxt['title']}")
    elif cmd == "list":
        filt = args[args.index("--status") + 1] if "--status" in args else None
        for r in sorted(rows.values(), key=lambda r: r["id"]):
            if not filt or r["status"] == filt:
                print(f"[{r['status']:11s}] {r['id']}: {r['title']}")
    elif cmd == "next":
        r = next((r for r in sorted(rows.values(), key=lambda r: r["id"]) if r["status"] == "planned"), None)
        print(f"{r['id']}: {r['title']}" if r else "No planned sprints")
    elif cmd == "add" and len(args) >= 3:
        sid = args[1].zfill(3)
        rows[sid] = {"id": sid, "title": " ".join(args[2:]), "status": "planned", "ts": now()}
        save(tsv, rows); print(f"Added {sid}")
    elif cmd in ("start", "complete") and len(args) >= 2:
        sid, status = args[1].zfill(3), {"start": "in_progress", "complete": "completed"}[cmd]
        if sid not in rows: sys.exit(f"Not found: {sid}")
        rows[sid]["status"], rows[sid]["ts"] = status, now()
        save(tsv, rows); print(f"{sid} -> {status}")
    elif cmd == "sync":
        pat = re.compile(r"^# Sprint (\d+): (.+)$", re.MULTILINE)
        for f in sorted(d.glob("SPRINT-*.md")):
            m = re.match(r"SPRINT-(\d+)\.md", f.name)
            if not m: continue
            sid = m.group(1).zfill(3)
            tm = pat.search(f.read_text())
            title = tm.group(2).strip() if tm else f"Sprint {sid}"
            if sid not in rows:
                rows[sid] = {"id": sid, "title": title, "status": "planned", "ts": now()}
                print(f"Added {sid}: {title}")
        save(tsv, rows)
    else:
        print(__doc__); sys.exit(1)

if __name__ == "__main__":
    main()

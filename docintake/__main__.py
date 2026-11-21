"""python -m docintake demo              run the mailbox through the checks, print the scorecard, build site/
python -m docintake doc D-1018          one document: what was read and what the checks said
python -m docintake extract FILE.pdf    live: read a PDF with Claude and check it (needs ANTHROPIC_API_KEY)"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from .evals import run_queue, score


def show(item):
    print(f"{item.id}  {item.status}" + (f" → {item.approver}" if item.approver else ""))
    for k, f in item.ex["fields"].items():
        print(f"  {k:<16}{str(f['value']):<36}{f.get('evidence') or ''}")
    for c in item.checks:
        print(f"  [{c['level']}] {c['id']}: {c['detail']}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="docintake")
    ap.add_argument("cmd", choices=["demo", "doc", "extract"])
    ap.add_argument("arg", nargs="?")
    ap.add_argument("--site", default="site/index.html")
    a = ap.parse_args(argv)
    if a.cmd == "extract":
        from .data import master
        from .extract import ClaudeExtractor, pdf_document
        from .workflow import Queue

        show(Queue(master(), ClaudeExtractor()).ingest({**pdf_document(a.arg), "received_at": "", "truth": {}}))
        return 0
    q = run_queue()
    if a.cmd == "doc":
        show(q.items[a.arg])
        return 0
    s = score(q)
    print("AP intake demo: recorded extractions, real checks\n")
    for r in s["rows"]:
        print(f"  {r['id']}  {'ok ' if r['ok'] else 'BAD'} {r['got']:<15}{r['title']}  {', '.join(r['found'])}")
    print(f"\n{s['routed_right']} of {s['documents']} routed correctly. Planted problems caught: {s['planted_caught']} of {s['planted']}. "
          f"False alarms on clean bills: {s['false_alarms']}. Wrong model values that could post: {s['wrong_through']}.")
    Path("out").mkdir(exist_ok=True)
    Path("out/score.json").write_text(json.dumps(s, indent=1))
    if a.site:
        from .site import build
        print("site:", build(q, s, Path(a.site)))
    return 0 if s["routed_right"] == s["documents"] and s["wrong_through"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())

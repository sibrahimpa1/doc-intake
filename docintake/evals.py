"""Scores the pipeline against hand-set truth: how well the model read each field, whether every planted
problem was caught, whether clean invoices flow straight through, and whether any wrong value could post."""
from __future__ import annotations

from collections import defaultdict

from .data import ReplayExtractor, corpus, master
from .ledger import SandboxLedger
from .workflow import Queue

FIELDS = ("vendor_name", "tax_id", "invoice_number", "invoice_date", "due_date", "po_number", "currency", "subtotal", "tax", "shipping", "total", "bank_account")
WANT = {"auto": "approved", "approval": "needs_approval", "routed": "routed", "exception": "exception"}


def run_queue(extractor=None):
    m = master()
    q = Queue(m, extractor or ReplayExtractor(), SandboxLedger())
    for d in corpus():
        q.ingest(d)
    return q


def score(q) -> dict:
    per = defaultdict(lambda: [0, 0])
    rows, wrong_stopped, wrong_through = [], 0, 0
    for item in q.items.values():
        d, t = item.doc, item.doc["truth"]
        wrong = []
        for k in FIELDS:
            per[k][1] += 1
            if item.raw["fields"][k]["value"] == t[k]:
                per[k][0] += 1
            else:
                wrong.append(k)
        ids = {c["id"] for c in item.checks}
        want = set(d["expect"]) - {"needs_approval"}
        caught = want <= ids
        extra = sorted(ids - want - {"needs_approval"})
        ok_route = item.status == WANT[d["route"]]
        if wrong:
            if item.status in ("exception", "routed"):
                wrong_stopped += 1
            else:
                wrong_through += 1
        rows.append({"id": d["id"], "title": d["title"], "want": WANT[d["route"]], "got": item.status, "ok": ok_route and caught and not extra, "expected": sorted(want), "found": sorted(ids), "extra": extra, "model_wrong": wrong})
    bills = [r for r in rows if r["want"] != "routed"]
    clean = [r for r in rows if r["want"] in ("approved", "needs_approval")]
    planted = [r for r in rows if r["want"] == "exception"]
    return {"documents": len(rows), "routed_right": sum(r["want"] == r["got"] for r in rows),
            "planted": len(planted), "planted_caught": sum(set(r["expected"]) <= set(r["found"]) and r["got"] == "exception" for r in planted),
            "clean": len(clean), "false_alarms": sum(r["got"] == "exception" for r in clean),
            "straight_through": sum(r["got"] == "approved" for r in rows), "bills": len(bills),
            "model_wrong_docs": wrong_stopped + wrong_through, "wrong_stopped": wrong_stopped, "wrong_through": wrong_through,
            "field_accuracy": {k: round(v[0] / v[1], 4) for k, v in per.items()},
            "field_total": sum(v[1] for v in per.values()), "field_right": sum(v[0] for v in per.values()), "rows": rows}

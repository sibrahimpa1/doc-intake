"""The AP queue: every document's state, who did what, and the rules on who may do it.

    exception ──fix or override──▶ needs_approval ──approve──▶ approved ──post──▶ posted
    any open state ──hold──▶ on_hold ──release──▶ back through the checks
    any open state ──reject──▶ rejected        not a bill ──▶ routed

Separation of duties: whoever changed a document can't approve it, approvals respect each person's
limit, and a changed bank account needs the Controller plus a call-back reference. The audit log is
a hash chain, so an edited history is detectable.
"""
from __future__ import annotations

import copy
import hashlib
import json

from . import checks
from .parse import day, money


class Denied(Exception):
    """The action isn't allowed. The message is written for the person who tried it."""


OPEN = ("exception", "needs_approval", "on_hold")


class Item:
    def __init__(self, doc, extraction):
        self.doc, self.ex = doc, extraction
        self.raw = copy.deepcopy(extraction)
        self.status, self.approver, self.checks = "received", None, []
        self.overrides, self.editors, self.log = {}, set(), []
        self.posted_ref, self.approved_by = None, None

    @property
    def id(self):
        return self.doc["id"]

    def summary(self, master) -> dict:
        f = self.ex["fields"]
        return {"id": self.id, "sha256": self.doc["sha256"], "vendor": checks.match_vendor(f["vendor_name"]["value"], f["tax_id"]["value"], master)["id"],
                "number": f["invoice_number"]["value"], "total": f["total"]["value"], "date": f["invoice_date"]["value"], "po": f["po_number"]["value"],
                "lines": self.ex["lines"], "status": self.status}

    def record(self, who, action, detail=""):
        prev = self.log[-1]["hash"] if self.log else "0" * 16
        entry = {"seq": len(self.log) + 1, "who": who, "action": action, "detail": detail, "prev": prev}
        entry["hash"] = hashlib.sha256(json.dumps(entry, sort_keys=True).encode()).hexdigest()[:16]
        self.log.append(entry)

    def log_intact(self) -> bool:
        prev = "0" * 16
        for e in self.log:
            body = {k: v for k, v in e.items() if k != "hash"}
            if e["prev"] != prev or hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()[:16] != e["hash"]:
                return False
            prev = e["hash"]
        return True


class Queue:
    def __init__(self, master, extractor, ledger=None):
        self.master, self.extractor, self.ledger = master, extractor, ledger
        self.items: dict = {}

    # ---------- intake ----------
    def ingest(self, doc) -> Item:
        item = Item(doc, self.extractor.extract(doc))
        self.items[doc["id"]] = item
        item.record("system", "received", f"{doc['source']} from {doc['sender']}")
        item.record("model", "extracted", self.extractor.name)
        self._evaluate(item)
        return item

    def _prior(self, item):
        out = []
        for other in self.items.values():
            if other is item:
                break
            out.append(other.summary(self.master))
        return out

    def _evaluate(self, item):
        item.checks = checks.run(item.doc, item.ex, self.master, self._prior(item))
        live = {c["id"] for c in item.checks}
        item.overrides = {k: v for k, v in item.overrides.items() if k in live}
        r = checks.route(item.ex, item.checks, self.master, tuple(item.overrides), bool(item.editors))
        item.status, item.approver = r["status"], r["approver"]
        if r["approver"] == "auto":
            item.approved_by = "auto"
        item.record("system", "checked", f"{item.status}; open: " + (", ".join(c["id"] for c in item.checks if c["level"] != "info" and c["id"] not in item.overrides) or "none"))

    def _user(self, who):
        if who not in self.master["users"]:
            raise Denied(f"Unknown user {who}.")
        return self.master["users"][who]

    def _get(self, doc_id, *allowed):
        item = self.items[doc_id]
        if allowed and item.status not in allowed:
            raise Denied(f"{doc_id} is {item.status.replace('_', ' ')}, so this action isn't available.")
        return item

    # ---------- review ----------
    def correct(self, doc_id, who, field, value) -> Item:
        self._user(who)
        item = self._get(doc_id, "exception", "needs_approval")
        f = item.ex["fields"].get(field)
        if f is None:
            raise Denied(f"No field called {field}.")
        if field in checks.MONEY:
            parsed = money(value) if not isinstance(value, int) else value
            if parsed is None:
                raise Denied("That isn't an amount.")
            value = parsed
        elif field in checks.DATES:
            value = day(value)
            if value is None:
                raise Denied("That isn't a date.")
        old = f["value"]
        f.update({"value": value or None, "edited": True, "confidence": 1.0, "evidence": str(value)})
        item.editors.add(who)
        item.record(who, "corrected", f"{field}: {old} → {value}")
        self._evaluate(item)
        return item

    def correct_line(self, doc_id, who, index, **changes) -> Item:
        """Change a line's quantity, unit price, amount or GL account."""
        self._user(who)
        item = self._get(doc_id, "exception", "needs_approval")
        if not 0 <= index < len(item.ex["lines"]):
            raise Denied("No such line.")
        line = item.ex["lines"][index]
        for k, v in changes.items():
            if k not in ("qty", "unit_price", "amount", "gl"):
                raise Denied(f"Line field {k} can't be edited.")
            if k == "gl" and v not in self.master["gl"]:
                raise Denied("That GL account doesn't exist.")
            if k in ("unit_price", "amount") and not isinstance(v, int):
                v = money(v)
                if v is None:
                    raise Denied("That isn't an amount.")
            item.record(who, "corrected", f"line {index + 1} {k}: {line.get(k)} → {v}")
            line[k] = v
        item.editors.add(who)
        self._evaluate(item)
        return item

    def override(self, doc_id, who, check_id, reason, callback_ref=None) -> Item:
        user = self._user(who)
        item = self._get(doc_id, "exception")
        if check_id not in {c["id"] for c in item.checks}:
            raise Denied(f"{check_id} isn't open on {doc_id}.")
        if check_id in checks.NO_OVERRIDE:
            raise Denied("This can't be overridden. Fix the document or reject it.")
        if check_id not in user["can_override"]:
            raise Denied(f"{user['role']} can't override this. It needs a Controller.")
        if not (reason or "").strip():
            raise Denied("Say why you're overriding this.")
        if check_id == "bank_changed" and not (callback_ref or "").strip():
            raise Denied("Call the vendor on the number on file and enter the call reference first.")
        item.overrides[check_id] = {"by": who, "reason": reason, "callback_ref": callback_ref}
        item.editors.add(who)
        item.record(who, "overrode", f"{check_id}: {reason}" + (f" (call ref {callback_ref})" if callback_ref else ""))
        self._evaluate(item)
        return item

    def approve(self, doc_id, who) -> Item:
        user = self._user(who)
        item = self._get(doc_id, "needs_approval")
        if who in item.editors:
            raise Denied("You changed this document, so someone else has to approve it.")
        usd = abs(checks.amount_usd(item.ex, self.master))
        if usd > user["limit_cents"]:
            raise Denied(f"Above your approval limit of {checks.fmt(user['limit_cents'])}.")
        item.status, item.approved_by = "approved", who
        item.record(who, "approved", checks.fmt(usd))
        return item

    def reject(self, doc_id, who, reason) -> Item:
        self._user(who)
        item = self._get(doc_id, *OPEN)
        if not (reason or "").strip():
            raise Denied("Say why you're rejecting it; the vendor will be told.")
        item.status = "rejected"
        item.record(who, "rejected", reason)
        return item

    def hold(self, doc_id, who, reason) -> Item:
        self._user(who)
        item = self._get(doc_id, "exception", "needs_approval")
        item.status = "on_hold"
        item.record(who, "held", reason or "")
        return item

    def release(self, doc_id, who) -> Item:
        self._user(who)
        item = self._get(doc_id, "on_hold")
        item.record(who, "released")
        self._evaluate(item)
        return item

    def post(self, doc_id, who="system") -> Item:
        item = self._get(doc_id, "approved")
        if not self.ledger:
            raise Denied("No ledger is connected.")
        item.posted_ref = self.ledger.post(item, self.master)
        item.status = "posted"
        item.record(who, "posted", f"{self.ledger.name} {item.posted_ref}")
        return item

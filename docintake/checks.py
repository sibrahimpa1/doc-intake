"""Every rule that decides whether a document can be trusted. The model reads the page; this code
decides. docintake/web/rules.js is a line-for-line port so the review screen re-checks as you type,
and tests/test_parity.py runs both over every document."""
from __future__ import annotations

import re

from .parse import day, days_between, money, norm_name, norm_number, similarity, squash

MONEY = ("subtotal", "tax", "shipping", "total")
DATES = ("invoice_date", "due_date")
REQUIRED = ("vendor_name", "invoice_number", "invoice_date", "currency", "total")
NOT_BILLS = ("statement", "order_confirmation", "receipt")
INJECTION = re.compile(r"ignore (all |any )?(previous|prior|above) instructions|ai assistant|mark this invoice as approved|approve and pay|system prompt", re.I)
# These can't be waved through: the document has to be fixed or rejected.
NO_OVERRIDE = ("dup_exact", "dup_number", "vendor_unknown", "vendor_blocked", "po_unknown", "po_wrong_vendor", "po_closed", "po_line", "missing_field")


def _c(cid, level, field, title, detail):
    return {"id": cid, "level": level, "field": field, "title": title, "detail": detail}


def fmt(cents, cur="USD"):
    sign = "-" if cents < 0 else ""
    return f"{sign}{'€' if cur == 'EUR' else '$'}{abs(cents) // 100:,}.{abs(cents) % 100:02d}"


def page_text(doc) -> str:
    return squash(" ".join(t["t"] for p in doc["pages"] for t in p["tokens"]))


def match_vendor(name, tax_id, master) -> dict:
    n = norm_name(name)
    tid = squash(tax_id)
    best, best_score = None, 0.0
    for vid, v in master["vendors"].items():
        names = [norm_name(v["name"])] + [norm_name(a) for a in v["aliases"]]
        if n in names:
            return {"how": "name", "id": vid}
        if tid and squash(v["tax_id"]) == tid:
            return {"how": "tax_id", "id": vid}
        for x in names:
            s = similarity(n, x)
            if s > best_score:
                best, best_score = vid, s
    if best and best_score >= master["policy"]["fuzzy_vendor"]:
        return {"how": "lookalike", "id": None, "like": best, "score": round(best_score, 2)}
    return {"how": "none", "id": None}


def amount_usd(ex, master) -> int:
    f = ex["fields"]
    rate = master["policy"]["fx_to_usd"].get(f["currency"]["value"], 1.0)
    total = f["total"]["value"] or 0
    return int(abs(total) * rate + 0.5) * (1 if total >= 0 else -1)


def _grounding(doc, ex, policy, text, out):
    low_tokens = [squash(t["t"]) for p in doc["pages"] for t in p["tokens"] if t["c"] < policy["ocr_floor"]]
    for k, f in ex["fields"].items():
        if f.get("edited") or f.get("implied") or f.get("value") is None or (k in ("tax", "shipping") and not f["value"] and not f.get("evidence")):
            continue
        ev = f.get("evidence")
        if not ev or squash(ev) not in text:
            out.append(_c("not_on_page", "block", k, "Not on the page", f"The model reported {k.replace('_', ' ')} as “{ev or f['value']}”, but that text isn't on the document."))
            continue
        if k in MONEY and money(ev) != f["value"]:
            out.append(_c("not_on_page", "block", k, "Doesn't match the page", f"The page says {ev}; the model reported {fmt(f['value'])}."))
        elif k in DATES and day(ev) != f["value"]:
            out.append(_c("not_on_page", "block", k, "Doesn't match the page", f"The page says {ev}; the model reported {f['value']}."))
        elif f.get("confidence", 1) < policy["confidence_floor"] or squash(ev) in low_tokens:
            out.append(_c("low_confidence", "warn", k, "Hard to read", f"{k.replace('_', ' ').capitalize()} was read with low confidence. Compare it with the page."))


def _math(ex, cur, policy, out):
    f, tol = ex["fields"], policy["math_tolerance_cents"]
    for i, l in enumerate(ex["lines"]):
        if abs(l["qty"] * l["unit_price"] - l["amount"]) > tol:
            out.append(_c("math", "block", f"line:{i}", "Line doesn't multiply", f"Line {i + 1}: {l['qty']} × {fmt(l['unit_price'], cur)} is {fmt(l['qty'] * l['unit_price'], cur)}, not {fmt(l['amount'], cur)}."))
    lines = sum(l["amount"] for l in ex["lines"])
    sub, tax, ship, total = (f[k]["value"] or 0 for k in MONEY)
    if abs(lines - sub) > tol:
        out.append(_c("math", "block", "subtotal", "Lines don't add up", f"The lines add to {fmt(lines, cur)}; the subtotal says {fmt(sub, cur)}."))
    if abs(sub + tax + ship - total) > tol:
        out.append(_c("math", "block", "total", "Total doesn't add up", f"Subtotal, tax and freight come to {fmt(sub + tax + ship, cur)}; the total says {fmt(total, cur)}."))


def _dates(ex, vendor, policy, out):
    f = ex["fields"]
    inv, due = f["invoice_date"]["value"], f["due_date"]["value"]
    if not inv:
        return
    if inv > policy["today"]:
        out.append(_c("date_future", "block", "invoice_date", "Dated in the future", f"Invoice date {inv} is after today ({policy['today']})."))
    elif inv <= policy["closed_through"]:
        out.append(_c("period_closed", "block", "invoice_date", "Falls in a closed period", f"The books are closed through {policy['closed_through']}. A Controller must decide how to post it."))
    elif days_between(inv, policy["today"]) > policy["stale_days"]:
        out.append(_c("date_stale", "warn", "invoice_date", "Old invoice", f"Issued more than {policy['stale_days']} days ago."))
    if due and due < inv:
        out.append(_c("date_order", "block", "due_date", "Due before it was issued", f"Due {due}, issued {inv}."))
    elif due and vendor and abs(days_between(inv, due) - vendor["terms"]) > 3:
        out.append(_c("date_terms", "warn", "due_date", "Terms differ from the vendor file", f"Invoice gives {days_between(inv, due)} days; the vendor file says net {vendor['terms']}."))


def _po(ex, vendor, vid, master, prior, cur, out):
    f = ex["fields"]
    po_id = f["po_number"]["value"]
    if not po_id:
        if vendor and vendor["requires_po"]:
            out.append(_c("po_missing", "block", "po_number", "PO required", f"{vendor['name']} is a PO vendor and this invoice has no PO number."))
        return
    po = master["pos"].get(po_id)
    if not po:
        out.append(_c("po_unknown", "block", "po_number", "PO not found", f"{po_id} isn't in the purchasing system."))
        return
    if po["vendor"] != vid:
        out.append(_c("po_wrong_vendor", "block", "po_number", "PO belongs to another vendor", f"{po_id} was issued to {master['vendors'][po['vendor']]['name']}."))
        return
    if po["status"] != "open":
        out.append(_c("po_closed", "block", "po_number", "PO is closed", f"{po_id} was closed on {po.get('closed_on', 'an earlier date')}."))
        return
    tol = master["policy"]["price_tolerance_bps"]
    for i, l in enumerate(ex["lines"]):
        pl = next((x for x in po["lines"] if x["sku"] == l.get("sku")), None)
        if not pl:
            out.append(_c("po_line", "block", f"line:{i}", "Item isn't on the PO", f"Line {i + 1} ({l.get('sku') or l['description']}) isn't on {po_id}."))
            continue
        if l["unit_price"] * 10000 > pl["price"] * (10000 + tol):
            pct = (l["unit_price"] - pl["price"]) * 1000 // pl["price"]
            out.append(_c("po_price", "block", f"line:{i}", "Price above the PO", f"{pl['sku']}: billed {fmt(l['unit_price'], cur)}, PO price {fmt(pl['price'], cur)} (+{pct / 10:.1f}%, tolerance {tol / 100:.0f}%)."))
        already = pl["billed"] + sum(x["qty"] for p in prior if p["po"] == po_id and p["status"] in ("needs_approval", "approved", "posted") for x in p["lines"] if x["sku"] == pl["sku"])
        if l["qty"] > pl["received"] - already:
            out.append(_c("po_qty", "block", f"line:{i}", "Billed for more than received", f"{pl['sku']}: billed {l['qty']}, received {pl['received']}, already billed {already}."))


def run(doc, ex, master, prior) -> list:
    """All checks for one document. `prior` is what's already in the queue, oldest first."""
    policy, f, out = master["policy"], ex["fields"], []
    text = page_text(doc)
    if INJECTION.search(text):
        out.append(_c("injection", "block", None, "Instructions hidden in the document", "The page contains text addressed to an AI system. It was treated as data and ignored; a person should look at this one."))
    if ex["doc_type"] in NOT_BILLS:
        out.append(_c("not_a_bill", "info", None, "Not a bill", f"This is a {ex['doc_type'].replace('_', ' ')}. Nothing to pay, so it's filed and routed."))
        return out
    for k in REQUIRED:
        if f[k].get("value") in (None, ""):
            out.append(_c("missing_field", "block", k, "Missing field", f"{k.replace('_', ' ').capitalize()} is required."))
    _grounding(doc, ex, policy, text, out)
    m = match_vendor(f["vendor_name"]["value"], f["tax_id"]["value"], master)
    vid, vendor = m["id"], master["vendors"].get(m["id"])
    cur = f["currency"]["value"] or "USD"
    if m["how"] == "lookalike":
        like = master["vendors"][m["like"]]
        out.append(_c("vendor_lookalike", "block", "vendor_name", "Looks like a vendor you know, but isn't", f"“{f['vendor_name']['value']}” is {round(m['score'] * 100)}% similar to {like['name']}, with a different tax ID and bank account."))
    elif m["how"] == "none":
        out.append(_c("vendor_unknown", "block", "vendor_name", "Unknown vendor", f"“{f['vendor_name']['value']}” isn't in the vendor file. Onboard it before paying."))
    if vendor:
        if vendor["status"] == "blocked":
            out.append(_c("vendor_blocked", "block", "vendor_name", "Vendor on hold", vendor.get("block_reason", "Payments to this vendor are on hold.")))
        if squash(f["bank_account"]["value"]) != squash(vendor["bank"]):
            out.append(_c("bank_changed", "block", "bank_account", "Bank details changed", f"The invoice pays to {f['bank_account']['value']}; the vendor file has an account ending {vendor['bank'][-4:]}. Call the vendor on the number on file before paying."))
        if cur != vendor["currency"]:
            out.append(_c("currency", "block", "currency", "Wrong currency", f"Billed in {cur}; {vendor['name']} bills in {vendor['currency']}."))
    dup = False
    for p in prior:
        if p["status"] == "rejected":
            continue
        if p["sha256"] == doc["sha256"]:
            out.append(_c("dup_exact", "block", "invoice_number", "Exact duplicate", f"The same file was received as {p['id']}."))
            dup = True
            break
        if vid and p["vendor"] == vid and norm_number(p["number"]) == norm_number(f["invoice_number"]["value"]):
            out.append(_c("dup_number", "block", "invoice_number", "Already received", f"{p['id']} has the same vendor and invoice number ({p['number']})."))
            dup = True
            break
    if not dup and vid:
        for p in prior:
            if p["status"] != "rejected" and p["vendor"] == vid and p["total"] == f["total"]["value"] and p["date"] and f["invoice_date"]["value"] and abs(days_between(p["date"], f["invoice_date"]["value"])) <= 7:
                out.append(_c("dup_soft", "warn", "total", "Possible duplicate", f"{p['id']} from this vendor has the same amount within a week."))
                break
    _math(ex, cur, policy, out)
    tax, sub = f["tax"]["value"] or 0, f["subtotal"]["value"] or 0
    if vendor and vendor["currency"] == cur:
        expected = (sub * vendor["tax_bps"] + 5000) // 10000
        if abs(tax - expected) > policy["math_tolerance_cents"]:
            out.append(_c("tax_rate", "warn", "tax", "Tax doesn't match", f"Expected {fmt(expected, cur)} at {vendor['tax_bps'] / 100:.2f}%; billed {fmt(tax, cur)}."))
    _dates(ex, vendor, policy, out)
    if ex["doc_type"] == "credit_note":
        out.append(_c("credit_note", "info", None, "Credit note", "Reduces what you owe this vendor. A manager confirms it before it's applied."))
    elif not dup and vendor:
        _po(ex, vendor, vid, master, prior, cur, out)
    return out


def route(ex, checks, master, overridden=(), changed=False) -> dict:
    """Where the document goes next, given its open checks."""
    open_ = [c for c in checks if c["level"] != "info" and c["id"] not in overridden]
    if any(c["id"] == "not_a_bill" for c in checks):
        return {"status": "routed", "approver": None}
    if open_:
        return {"status": "exception", "approver": None}
    usd = abs(amount_usd(ex, master))
    limit = master["policy"]["auto_post_limit_cents"]
    credit = ex["doc_type"] == "credit_note"
    if usd <= limit and not credit and not overridden and not changed:
        return {"status": "approved", "approver": "auto"}
    tiers = sorted(((u["limit_cents"], k) for k, u in master["users"].items() if u["limit_cents"] > 0))
    who = next((k for lim, k in tiers if usd <= lim), tiers[-1][1])
    return {"status": "needs_approval", "approver": who}

"""Posting approved bills to the accounting system. Payloads have the shape of the real APIs:
QuickBooks Online `Bill`, Xero `Invoices` (ACCPAY). The sandbox ledger behaves like one: idempotent,
and it can fail transiently so the retry path is real. With credentials, LiveLedger sends them."""
from __future__ import annotations

import hashlib
import json
import os
import urllib.request

from . import checks


def gl_for(line, vendor, po) -> str:
    if line.get("gl"):
        return line["gl"]
    if po:
        for x in po["lines"]:
            if x["sku"] == line.get("sku") and x.get("gl"):
                return x["gl"]
    return (vendor or {}).get("gl", "6900")


def _parts(item, master):
    f = item.ex["fields"]
    vid = checks.match_vendor(f["vendor_name"]["value"], f["tax_id"]["value"], master)["id"]
    return f, vid, master["vendors"].get(vid), master["pos"].get(f["po_number"]["value"])


def qbo_bill(item, master) -> dict:
    f, vid, vendor, po = _parts(item, master)
    lines = [{"DetailType": "AccountBasedExpenseLineDetail", "Amount": l["amount"] / 100, "Description": l["description"],
              "AccountBasedExpenseLineDetail": {"AccountRef": {"value": gl_for(l, vendor, po), "name": master["gl"].get(gl_for(l, vendor, po))}}} for l in item.ex["lines"]]
    for key, label, gl in (("tax", "Sales tax", "6900"), ("shipping", "Freight", "6100")):
        if f[key]["value"]:
            lines.append({"DetailType": "AccountBasedExpenseLineDetail", "Amount": f[key]["value"] / 100, "Description": label,
                          "AccountBasedExpenseLineDetail": {"AccountRef": {"value": gl, "name": master["gl"][gl]}}})
    return {"VendorRef": {"value": vid, "name": vendor["name"] if vendor else f["vendor_name"]["value"]}, "DocNumber": f["invoice_number"]["value"],
            "TxnDate": f["invoice_date"]["value"], "DueDate": f["due_date"]["value"], "CurrencyRef": {"value": f["currency"]["value"]},
            "PrivateNote": f"AP intake {item.id}", "Line": lines}


def xero_invoice(item, master) -> dict:
    f, vid, vendor, po = _parts(item, master)
    return {"Invoices": [{"Type": "ACCPAYCREDIT" if item.ex["doc_type"] == "credit_note" else "ACCPAY", "Contact": {"Name": vendor["name"] if vendor else f["vendor_name"]["value"]},
                          "InvoiceNumber": f["invoice_number"]["value"], "Date": f["invoice_date"]["value"], "DueDate": f["due_date"]["value"], "CurrencyCode": f["currency"]["value"],
                          "Status": "AUTHORISED", "LineAmountTypes": "Exclusive",
                          "LineItems": [{"Description": l["description"], "Quantity": l["qty"], "UnitAmount": l["unit_price"] / 100, "AccountCode": gl_for(l, vendor, po)} for l in item.ex["lines"]]}]}


def idempotency_key(item) -> str:
    f = item.ex["fields"]
    raw = "|".join(str(f[k]["value"]) for k in ("vendor_name", "invoice_number", "total"))
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


class TransientError(Exception):
    pass


class SandboxLedger:
    name = "QuickBooks sandbox"

    def __init__(self, fail_times: int = 0):
        self.bills, self.fail_times, self.calls = {}, fail_times, 0

    def post(self, item, master, retries: int = 3) -> str:
        key, payload = idempotency_key(item), qbo_bill(item, master)
        for attempt in range(retries + 1):
            try:
                return self._send(key, payload)
            except TransientError:
                if attempt == retries:
                    raise
        raise TransientError("unreachable")

    def _send(self, key, payload) -> str:
        self.calls += 1
        if self.fail_times > 0:
            self.fail_times -= 1
            raise TransientError("503 from ledger")
        if key not in self.bills:
            self.bills[key] = {"Id": f"BILL-{9001 + len(self.bills)}", **payload}
        return self.bills[key]["Id"]


class LiveLedger:
    """QuickBooks Online. Needs QBO_ACCESS_TOKEN and QBO_REALM_ID; use the sandbox base URL until you've reviewed it."""
    name = "QuickBooks Online"

    def __init__(self, base="https://sandbox-quickbooks.api.intuit.com"):
        self.base, self.token, self.realm = base, os.environ["QBO_ACCESS_TOKEN"], os.environ["QBO_REALM_ID"]

    def post(self, item, master) -> str:
        url = f"{self.base}/v3/company/{self.realm}/bill?requestid={idempotency_key(item)}"
        req = urllib.request.Request(url, data=json.dumps(qbo_bill(item, master)).encode(), method="POST",
                                     headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)["Bill"]["Id"]

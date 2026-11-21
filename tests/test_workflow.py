import pytest

from docintake.data import ReplayExtractor, corpus, master
from docintake.evals import run_queue
from docintake.ledger import SandboxLedger, TransientError, qbo_bill, xero_invoice
from docintake.workflow import Denied, Queue


def find(q, title):
    return next(i for i in q.items.values() if i.doc["title"] == title)


def test_clerk_fixes_a_misread_and_someone_else_approves():
    q = run_queue()
    i = find(q, "Model misread the total")
    q.correct(i.id, "maya", "total", "1,183.00")
    assert i.status == "needs_approval" and i.approver == "tom"
    with pytest.raises(Denied, match="someone else"):
        q.approve(i.id, "maya")
    q.approve(i.id, "tom")
    q.post(i.id)
    assert i.status == "posted" and i.posted_ref.startswith("BILL-")


def test_approval_limits():
    q = run_queue()
    rent = find(q, "Rent, Controller approval")
    assert rent.approver == "dana"
    with pytest.raises(Denied, match="limit"):
        q.approve(rent.id, "tom")
    q.approve(rent.id, "dana")


def test_bank_change_needs_controller_and_a_call():
    q = run_queue()
    i = find(q, "Bank details changed")
    with pytest.raises(Denied, match="Controller"):
        q.override(i.id, "tom", "bank_changed", "looks fine")
    with pytest.raises(Denied, match="call reference"):
        q.override(i.id, "dana", "bank_changed", "verified")
    q.override(i.id, "dana", "bank_changed", "verified with owner", "CALL-2291")
    assert i.status == "needs_approval"
    with pytest.raises(Denied):
        q.approve(i.id, "dana")
    q.approve(i.id, "tom")


@pytest.mark.parametrize("title,check", [("Same file sent twice", "dup_exact"), ("Unknown vendor", "vendor_unknown"), ("Vendor on hold", "vendor_blocked"), ("PO already closed", "po_closed")])
def test_some_problems_cant_be_overridden(title, check):
    q = run_queue()
    with pytest.raises(Denied, match="can't be overridden"):
        q.override(find(q, title).id, "dana", check, "please")


def test_reason_is_required_and_hold_release_rechecks():
    q = run_queue()
    i = find(q, "Wrong sales tax")
    with pytest.raises(Denied):
        q.override(i.id, "tom", "tax_rate", " ")
    with pytest.raises(Denied):
        q.reject(i.id, "tom", "")
    q.hold(i.id, "maya", "waiting for vendor")
    assert i.status == "on_hold"
    q.release(i.id, "maya")
    assert i.status == "exception"


def test_only_approved_documents_post_and_posting_is_idempotent():
    q = run_queue()
    i = find(q, "Wrong sales tax")
    with pytest.raises(Denied):
        q.post(i.id)
    ok = next(x for x in q.items.values() if x.status == "approved")
    ref = q.post(ok.id).posted_ref
    assert q.ledger.post(ok, q.master) == ref and len(q.ledger.bills) == 1


def test_ledger_retries_transient_failures():
    m = master()
    q = Queue(m, ReplayExtractor(), SandboxLedger(fail_times=2))
    for d in corpus():
        q.ingest(d)
    ok = next(x for x in q.items.values() if x.status == "approved")
    q.post(ok.id)
    assert ok.status == "posted" and q.ledger.calls == 3
    q2 = Queue(m, ReplayExtractor(), SandboxLedger(fail_times=9))
    for d in corpus():
        q2.ingest(d)
    ok2 = next(x for x in q2.items.values() if x.status == "approved")
    with pytest.raises(TransientError):
        q2.post(ok2.id)
    assert ok2.status == "approved"


def test_audit_log_detects_tampering():
    q = run_queue()
    i = find(q, "Wrong sales tax")
    q.override(i.id, "tom", "tax_rate", "agreed with vendor")
    assert i.log_intact()
    i.log[1]["detail"] = "changed"
    assert not i.log_intact()


def test_payloads():
    q = run_queue()
    i = find(q, "Clean three-way match")
    b = qbo_bill(i, q.master)
    assert round(sum(l["Amount"] for l in b["Line"]), 2) == i.ex["fields"]["total"]["value"] / 100
    assert xero_invoice(i, q.master)["Invoices"][0]["Type"] == "ACCPAY"
    cn = find(q, "Credit note")
    assert xero_invoice(cn, q.master)["Invoices"][0]["Type"] == "ACCPAYCREDIT"


def test_api_flow():
    pytest.importorskip("fastapi")
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient

    from docintake.api import make_app

    q = run_queue()
    c = TestClient(make_app(q))
    i = find(q, "Model misread the total")
    assert c.get("/queue", params={"status": "exception"}).status_code == 200
    r = c.post(f"/docs/{i.id}/correct", json={"field": "total", "value": "1,183.00"}, headers={"X-User": "maya"})
    assert r.json()["status"] == "needs_approval"
    assert c.post(f"/docs/{i.id}/approve", headers={"X-User": "maya"}).status_code == 403
    assert c.post(f"/docs/{i.id}/approve", headers={"X-User": "tom"}).json()["status"] == "approved"
    assert c.post(f"/docs/{i.id}/post", headers={"X-User": "tom"}).json()["posted_ref"]
    assert c.get("/docs/D-9999").status_code == 404


def test_real_pdf_text_layer():
    pytest.importorskip("pypdf")
    from pathlib import Path

    from docintake.extract import pdf_document

    d = pdf_document(Path(__file__).parent.parent / "samples" / "D-1001.pdf")
    words = {t["t"] for t in d["pages"][0]["tokens"]}
    assert "BH-20418" in words and "PO-5110" in words

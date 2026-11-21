import copy

import pytest

from docintake import checks
from docintake.data import corpus, master, recording
from docintake.evals import run_queue, score


def by_title(title):
    return next(d for d in corpus() if d["title"] == title)


def test_every_document_routes_as_labelled():
    s = score(run_queue())
    assert s["routed_right"] == s["documents"]
    assert all(r["ok"] for r in s["rows"]), [r for r in s["rows"] if not r["ok"]]
    assert s["planted_caught"] == s["planted"] and s["false_alarms"] == 0


def test_wrong_model_values_never_reach_approval():
    s = score(run_queue())
    assert s["model_wrong_docs"] >= 2 and s["wrong_through"] == 0


def clean():
    d = by_title("Monthly cleaning")
    return d, recording(d["id"]), master()


def ids(d, ex, m, prior=()):
    return {c["id"] for c in checks.run(d, ex, m, list(prior))}


def test_clean_invoice_has_no_open_checks():
    d, ex, m = clean()
    assert not ids(d, ex, m)
    assert checks.route(ex, [], m)["status"] == "approved"


@pytest.mark.parametrize("field,value,expected", [("total", 999999, "not_on_page"), ("invoice_date", "2026-12-25", "not_on_page"), ("bank_account", "000-111", "bank_changed")])
def test_changed_values_are_caught(field, value, expected):
    d, ex, m = clean()
    ex["fields"][field]["value"] = value
    assert expected in ids(d, ex, m)


def test_hand_edit_skips_grounding_but_not_math():
    d, ex, m = clean()
    ex["fields"]["total"].update(value=5, edited=True)
    found = ids(d, ex, m)
    assert "not_on_page" not in found and "math" in found


def test_auto_post_limit_is_policy():
    d, ex, m = clean()
    m["policy"]["auto_post_limit_cents"] = 1000
    assert checks.route(ex, [], m) == {"status": "needs_approval", "approver": "tom"}


def test_eur_amounts_are_converted_for_limits():
    d = by_title("Equipment in euros")
    ex, m = recording(d["id"]), master()
    assert checks.amount_usd(ex, m) == round(776000 * 1.0842)


def test_po_qty_counts_what_was_already_billed():
    d = by_title("Clean three-way match")
    ex, m = recording(d["id"]), master()
    prior = [{"id": "X", "sha256": "x", "vendor": "V-99", "number": "n", "total": 1, "date": "2026-01-01", "po": ex["fields"]["po_number"]["value"], "status": "posted",
              "lines": copy.deepcopy(ex["lines"])}]
    assert "po_qty" in ids(d, ex, m, prior)


def test_rejected_documents_dont_count_as_duplicates():
    d, ex, m = clean()
    prior = [{"id": "X", "sha256": d["sha256"], "vendor": "V-09", "number": d["truth"]["invoice_number"], "total": 1, "date": None, "po": None, "status": "rejected", "lines": []}]
    assert "dup_exact" not in ids(d, ex, m, prior)

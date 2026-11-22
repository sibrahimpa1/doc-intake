"""The browser re-checks as you type, so its rules must agree with the Python rules exactly."""
import copy
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from docintake import checks
from docintake.data import corpus, master, recording

ROOT = Path(__file__).resolve().parent.parent
RUNNER = """
const R = require(process.argv[2]), fs = require('fs');
const cases = JSON.parse(fs.readFileSync(process.argv[3]));
const out = cases.map(c => { const r = R.run(c.doc, c.ex, c.master, c.prior); return {checks: r, route: R.route(c.ex, r, c.master, [], false), usd: R.amountUsd(c.ex, c.master)}; });
fs.writeFileSync(process.argv[4], JSON.stringify(out));
"""


def cases():
    m, prior, out = master(), [], []
    for d in corpus():
        ex = recording(d["id"])
        out.append({"doc": d, "ex": ex, "master": m, "prior": copy.deepcopy(prior)})
        r = checks.route(ex, checks.run(d, ex, m, prior), m)
        f = ex["fields"]
        prior.append({"id": d["id"], "sha256": d["sha256"], "vendor": checks.match_vendor(f["vendor_name"]["value"], f["tax_id"]["value"], m)["id"],
                      "number": f["invoice_number"]["value"], "total": f["total"]["value"], "date": f["invoice_date"]["value"], "po": f["po_number"]["value"], "lines": ex["lines"], "status": r["status"]})
    # edited variants: wrong values typed by a reviewer
    for c in list(out)[:14]:
        e = copy.deepcopy(c)
        e["ex"]["fields"]["total"].update(value=(e["ex"]["fields"]["total"]["value"] or 0) + 1234, edited=True)
        e["ex"]["fields"]["due_date"].update(value="2026-01-01", edited=True)
        e["ex"]["lines"] = e["ex"]["lines"][:-1]
        out.append(e)
    return out


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
def test_browser_rules_match_python(tmp_path):
    cs = cases()
    (tmp_path / "in.json").write_text(json.dumps(cs))
    (tmp_path / "run.js").write_text(RUNNER)
    subprocess.run(["node", str(tmp_path / "run.js"), str(ROOT / "docintake" / "web" / "rules.js"), str(tmp_path / "in.json"), str(tmp_path / "out.json")], check=True)
    js = json.loads((tmp_path / "out.json").read_text())
    for c, j in zip(cs, js):
        py = checks.run(c["doc"], c["ex"], c["master"], c["prior"])
        assert py == j["checks"], c["doc"]["id"]
        assert checks.route(c["ex"], py, c["master"]) == j["route"]
        assert checks.amount_usd(c["ex"], c["master"]) == j["usd"]

"""Builds the live demo: one self-contained HTML file with inline CSS, JS and the synthetic data."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from .data import ROOT, master

WEB = Path(__file__).parent / "web"
KEEP = ("id", "title", "file", "sha256", "received_at", "source", "sender", "pages")


def build(queue, score: dict, out: Path) -> Path:
    docs = [{**{k: i.doc[k] for k in KEEP}, "raw": i.raw} for i in queue.items.values()]
    data = json.dumps({"master": master(), "docs": docs, "score": score}, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    html = (WEB / "index.html").read_text(encoding="utf-8")
    for mark, name in (("/*__CSS__*/", "style.css"), ("/*__RULES__*/", "rules.js"), ("/*__APP__*/", "app.js")):
        html = html.replace(mark, (WEB / name).read_text(encoding="utf-8"))
    html = html.replace("/*__DATA__*/null", data)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    pdfs = out.parent / "pdf"
    pdfs.mkdir(exist_ok=True)
    for f in (ROOT / "samples").glob("*.pdf"):
        shutil.copy2(f, pdfs / f.name)
    return out

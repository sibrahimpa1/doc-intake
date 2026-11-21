"""The service a team would run: upload, queue, review actions, posting.

    pip install -e ".[live]"
    ANTHROPIC_API_KEY=... DOCINTAKE_LIVE=1 uvicorn docintake.api:app --port 8000

The X-User header stands in for your SSO; put a real identity provider in front before going live.
"""
from __future__ import annotations

import os
import tempfile

from .data import ReplayExtractor, corpus, master
from .ledger import SandboxLedger
from .workflow import Denied, Queue

try:
    from fastapi import Body, FastAPI, Header, HTTPException, UploadFile
except ImportError:  # pragma: no cover
    FastAPI = None


def view(item, full=False) -> dict:
    f = item.ex["fields"]
    out = {"id": item.id, "status": item.status, "approver": item.approver, "vendor": f["vendor_name"]["value"], "number": f["invoice_number"]["value"],
           "total": f["total"]["value"], "currency": f["currency"]["value"], "open": [c["id"] for c in item.checks if c["level"] != "info" and c["id"] not in item.overrides], "posted_ref": item.posted_ref}
    if full:
        out.update({"fields": f, "lines": item.ex["lines"], "checks": item.checks, "overrides": item.overrides, "log": item.log, "log_intact": item.log_intact()})
    return out


def make_app(queue=None, extractor=None):
    app = FastAPI(title="AP intake")
    q = queue or Queue(master(), extractor or ReplayExtractor(), SandboxLedger())

    def act(fn, *a, **kw):
        try:
            return view(fn(*a, **kw), True)
        except Denied as e:
            raise HTTPException(403, str(e))
        except KeyError:
            raise HTTPException(404, "No such document.")

    @app.get("/queue")
    def queue_list(status: str = None):
        return [view(i) for i in q.items.values() if not status or i.status == status]

    @app.get("/docs/{doc_id}")
    def doc(doc_id: str):
        if doc_id not in q.items:
            raise HTTPException(404, "No such document.")
        return view(q.items[doc_id], True)

    @app.post("/docs/{doc_id}/correct")
    def correct(doc_id: str, field: str = Body(...), value=Body(...), x_user: str = Header(...)):
        return act(q.correct, doc_id, x_user, field, value)

    @app.post("/docs/{doc_id}/override")
    def override(doc_id: str, check: str = Body(...), reason: str = Body(...), callback_ref: str = Body(None), x_user: str = Header(...)):
        return act(q.override, doc_id, x_user, check, reason, callback_ref)

    @app.post("/docs/{doc_id}/approve")
    def approve(doc_id: str, x_user: str = Header(...)):
        return act(q.approve, doc_id, x_user)

    @app.post("/docs/{doc_id}/reject")
    def reject(doc_id: str, reason: str = Body(..., embed=True), x_user: str = Header(...)):
        return act(q.reject, doc_id, x_user, reason)

    @app.post("/docs/{doc_id}/hold")
    def hold(doc_id: str, reason: str = Body("", embed=True), x_user: str = Header(...)):
        return act(q.hold, doc_id, x_user, reason)

    @app.post("/docs/{doc_id}/release")
    def release(doc_id: str, x_user: str = Header(...)):
        return act(q.release, doc_id, x_user)

    @app.post("/docs/{doc_id}/post")
    def post(doc_id: str, x_user: str = Header(...)):
        return act(q.post, doc_id, x_user)

    @app.post("/upload")
    async def upload(file: UploadFile):
        from .extract import pdf_document

        blob = await file.read()
        if not blob.startswith(b"%PDF"):
            raise HTTPException(415, "Send a PDF.")
        with tempfile.NamedTemporaryFile(suffix=".pdf") as t:
            t.write(blob)
            t.flush()
            doc = pdf_document(t.name, source="upload")
        return view(q.ingest({**doc, "received_at": "", "truth": {}}), True)

    app.state.queue = q
    return app


def _live():
    from .extract import ClaudeExtractor

    return make_app(extractor=ClaudeExtractor())


def demo_app():
    q = Queue(master(), ReplayExtractor(), SandboxLedger())
    for d in corpus():
        q.ingest(d)
    return make_app(q)


app = (_live() if os.environ.get("DOCINTAKE_LIVE") == "1" else demo_app()) if FastAPI else None

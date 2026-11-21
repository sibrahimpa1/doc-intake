"""The synthetic world: vendor master, POs, policy, the document corpus and recorded extractions."""
from __future__ import annotations

import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def master() -> dict:
    return json.loads((ROOT / "data" / "master.json").read_text())


def corpus() -> list:
    return json.loads((ROOT / "data" / "docs" / "corpus.json").read_text())


def recording(doc_id: str) -> dict:
    return json.loads((ROOT / "recordings" / f"{doc_id}.json").read_text())


class ReplayExtractor:
    """Recorded model output, so the demo and CI need no API key."""
    name = "replay"

    def extract(self, doc: dict) -> dict:
        return copy.deepcopy(recording(doc["id"]))

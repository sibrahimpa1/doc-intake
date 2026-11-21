"""Reading values the way they are printed on a document. Money is kept in integer cents."""
from __future__ import annotations

import re
from datetime import date, datetime
from functools import lru_cache

MONTHS = {m: i + 1 for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}


def money(text) -> int | None:
    """'$1,234.50', '1.234,50', '(45.00)' and '-45.00' to cents. None if it isn't an amount."""
    if text is None:
        return None
    s = str(text).strip()
    negative = s.startswith("(") or s.startswith("-") or s.endswith("-") or "CR" in s.upper().split()
    s = re.sub(r"[^\d.,]", "", s)
    if not re.search(r"\d", s):
        return None
    last_dot, last_comma = s.rfind("."), s.rfind(",")
    sep = max(last_dot, last_comma)
    if sep >= 0 and len(s) - sep - 1 in (1, 2):
        whole, frac = s[:sep], s[sep + 1:].ljust(2, "0")
    else:
        whole, frac = s, "00"
    whole = re.sub(r"[.,]", "", whole) or "0"
    cents = int(whole) * 100 + int(frac)
    return -cents if negative else cents


def day(text) -> str | None:
    """'11/03/2026' (US), '03.11.2026' (EU), '2026-11-03' and 'Nov 3, 2026' to an ISO date."""
    if not text:
        return None
    s = str(text).strip()
    y = mo = d = None
    m = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        y, mo, d = int(m[1]), int(m[2]), int(m[3])
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})", s)
    if m:
        mo, d, y = int(m[1]), int(m[2]), int(m[3])
    m = re.fullmatch(r"(\d{1,2})\.(\d{1,2})\.(\d{4})", s)
    if m:
        d, mo, y = int(m[1]), int(m[2]), int(m[3])
    m = re.fullmatch(r"([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})", s)
    if m and m[1].lower() in MONTHS:
        mo, d, y = MONTHS[m[1].lower()], int(m[2]), int(m[3])
    if y is None:
        return None
    try:
        return date(y, mo, d).isoformat()
    except ValueError:
        return None


def days_between(a: str, b: str) -> int:
    return (datetime.strptime(b, "%Y-%m-%d") - datetime.strptime(a, "%Y-%m-%d")).days


def norm_number(s) -> str:
    """Invoice numbers compare without punctuation, case or leading zeros: INV-00418 == inv418."""
    t = re.sub(r"[^a-z0-9]", "", str(s or "").lower())
    return re.sub(r"(?<=[a-z])0+(?=\d)", "", t)


def norm_name(s) -> str:
    t = re.sub(r"[^a-z0-9 ]", " ", str(s or "").lower())
    t = re.sub(r"\b(inc|llc|ltd|co|corp|company|sro|s r o)\b", " ", t)
    return " ".join(t.split())


@lru_cache(maxsize=4096)
def similarity(a: str, b: str) -> float:
    """Normalised Levenshtein similarity, 1.0 for identical strings."""
    if a == b:
        return 1.0
    if not a or not b:
        return 0.0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return 1 - prev[-1] / max(len(a), len(b))


def squash(s) -> str:
    return " ".join(str(s or "").split()).lower()

/* Port of parse.py and checks.py so the review screen re-checks as you type.
   tests/test_parity.py runs both over every document and compares the results. */
(function (root) {
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const MONEY = ["subtotal", "tax", "shipping", "total"], DATES = ["invoice_date", "due_date"];
  const REQUIRED = ["vendor_name", "invoice_number", "invoice_date", "currency", "total"];
  const NOT_BILLS = ["statement", "order_confirmation", "receipt"];
  const INJECTION = /ignore (all |any )?(previous|prior|above) instructions|ai assistant|mark this invoice as approved|approve and pay|system prompt/i;
  const NO_OVERRIDE = ["dup_exact", "dup_number", "vendor_unknown", "vendor_blocked", "po_unknown", "po_wrong_vendor", "po_closed", "po_line", "missing_field"];

  function money(text) {
    if (text === null || text === undefined) return null;
    let s = String(text).trim();
    const negative = s.startsWith("(") || s.startsWith("-") || s.endsWith("-") || s.toUpperCase().split(/\s+/).includes("CR");
    s = s.replace(/[^\d.,]/g, "");
    if (!/\d/.test(s)) return null;
    const sep = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
    let whole, frac;
    if (sep >= 0 && (s.length - sep - 1 === 1 || s.length - sep - 1 === 2)) { whole = s.slice(0, sep); frac = s.slice(sep + 1).padEnd(2, "0"); }
    else { whole = s; frac = "00"; }
    whole = whole.replace(/[.,]/g, "") || "0";
    const cents = parseInt(whole, 10) * 100 + parseInt(frac, 10);
    return negative ? -cents : cents;
  }
  function day(text) {
    if (!text) return null;
    const s = String(text).trim();
    let y = null, mo, d, m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) { mo = +m[1]; d = +m[2]; y = +m[3]; }
    if ((m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/))) { d = +m[1]; mo = +m[2]; y = +m[3]; }
    if ((m = s.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/)) && MONTHS[m[1].toLowerCase()]) { mo = MONTHS[m[1].toLowerCase()]; d = +m[2]; y = +m[3]; }
    if (y === null) return null;
    const t = new Date(Date.UTC(y, mo - 1, d));
    if (t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
    return t.toISOString().slice(0, 10);
  }
  const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
  const normNumber = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "").replace(/(?<=[a-z])0+(?=\d)/g, "");
  const normName = s => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\b(inc|llc|ltd|co|corp|company|sro|s r o)\b/g, " ").split(/\s+/).filter(Boolean).join(" ");
  const squash = s => String(s === null || s === undefined ? "" : s).split(/\s+/).filter(Boolean).join(" ").toLowerCase();
  const simCache = new Map();
  function similarity(a, b) {
    if (a === b) return 1;
    if (!a || !b) return 0;
    const key = a + "\u0000" + b;
    if (simCache.has(key)) return simCache.get(key);
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)));
      prev = cur;
    }
    const r = 1 - prev[b.length] / Math.max(a.length, b.length);
    simCache.set(key, r);
    return r;
  }
  const C = (id, level, field, title, detail) => ({ id, level, field, title, detail });
  const label = k => k.replace(/_/g, " ");
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  function fmt(cents, cur) {
    const a = Math.abs(cents), whole = Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (cents < 0 ? "-" : "") + (cur === "EUR" ? "€" : "$") + whole + "." + String(a % 100).padStart(2, "0");
  }
  const pageText = doc => squash(doc.pages.flatMap(p => p.tokens.map(t => t.t)).join(" "));

  function matchVendor(name, taxId, master) {
    const n = normName(name), tid = squash(taxId);
    let best = null, bestScore = 0;
    for (const [vid, v] of Object.entries(master.vendors)) {
      const names = [normName(v.name), ...v.aliases.map(normName)];
      if (names.includes(n)) return { how: "name", id: vid };
      if (tid && squash(v.tax_id) === tid) return { how: "tax_id", id: vid };
      for (const x of names) { const s = similarity(n, x); if (s > bestScore) { best = vid; bestScore = s; } }
    }
    if (best && bestScore >= master.policy.fuzzy_vendor) return { how: "lookalike", id: null, like: best, score: Math.round(bestScore * 100) / 100 };
    return { how: "none", id: null };
  }
  function amountUsd(ex, master) {
    const f = ex.fields, rate = master.policy.fx_to_usd[f.currency.value] ?? 1, total = f.total.value || 0;
    return Math.floor(Math.abs(total) * rate + 0.5) * (total >= 0 ? 1 : -1);
  }
  function grounding(doc, ex, policy, text, out) {
    const low = doc.pages.flatMap(p => p.tokens.filter(t => t.c < policy.ocr_floor).map(t => squash(t.t)));
    for (const [k, f] of Object.entries(ex.fields)) {
      if (f.edited || f.implied || f.value === null || f.value === undefined || (["tax", "shipping"].includes(k) && !f.value && !f.evidence)) continue;
      const ev = f.evidence;
      if (!ev || !text.includes(squash(ev))) {
        out.push(C("not_on_page", "block", k, "Not on the page", `The model reported ${label(k)} as “${ev || f.value}”, but that text isn't on the document.`));
        continue;
      }
      if (MONEY.includes(k) && money(ev) !== f.value) out.push(C("not_on_page", "block", k, "Doesn't match the page", `The page says ${ev}; the model reported ${fmt(f.value)}.`));
      else if (DATES.includes(k) && day(ev) !== f.value) out.push(C("not_on_page", "block", k, "Doesn't match the page", `The page says ${ev}; the model reported ${f.value}.`));
      else if ((f.confidence ?? 1) < policy.confidence_floor || low.includes(squash(ev))) out.push(C("low_confidence", "warn", k, "Hard to read", `${cap(label(k))} was read with low confidence. Compare it with the page.`));
    }
  }
  function math(ex, cur, policy, out) {
    const f = ex.fields, tol = policy.math_tolerance_cents;
    ex.lines.forEach((l, i) => {
      if (Math.abs(l.qty * l.unit_price - l.amount) > tol) out.push(C("math", "block", `line:${i}`, "Line doesn't multiply", `Line ${i + 1}: ${l.qty} × ${fmt(l.unit_price, cur)} is ${fmt(l.qty * l.unit_price, cur)}, not ${fmt(l.amount, cur)}.`));
    });
    const lines = ex.lines.reduce((a, l) => a + l.amount, 0);
    const [sub, tax, ship, total] = MONEY.map(k => f[k].value || 0);
    if (Math.abs(lines - sub) > tol) out.push(C("math", "block", "subtotal", "Lines don't add up", `The lines add to ${fmt(lines, cur)}; the subtotal says ${fmt(sub, cur)}.`));
    if (Math.abs(sub + tax + ship - total) > tol) out.push(C("math", "block", "total", "Total doesn't add up", `Subtotal, tax and freight come to ${fmt(sub + tax + ship, cur)}; the total says ${fmt(total, cur)}.`));
  }
  function dates(ex, vendor, policy, out) {
    const inv = ex.fields.invoice_date.value, due = ex.fields.due_date.value;
    if (!inv) return;
    if (inv > policy.today) out.push(C("date_future", "block", "invoice_date", "Dated in the future", `Invoice date ${inv} is after today (${policy.today}).`));
    else if (inv <= policy.closed_through) out.push(C("period_closed", "block", "invoice_date", "Falls in a closed period", `The books are closed through ${policy.closed_through}. A Controller must decide how to post it.`));
    else if (daysBetween(inv, policy.today) > policy.stale_days) out.push(C("date_stale", "warn", "invoice_date", "Old invoice", `Issued more than ${policy.stale_days} days ago.`));
    if (due && due < inv) out.push(C("date_order", "block", "due_date", "Due before it was issued", `Due ${due}, issued ${inv}.`));
    else if (due && vendor && Math.abs(daysBetween(inv, due) - vendor.terms) > 3) out.push(C("date_terms", "warn", "due_date", "Terms differ from the vendor file", `Invoice gives ${daysBetween(inv, due)} days; the vendor file says net ${vendor.terms}.`));
  }
  function po(ex, vendor, vid, master, prior, cur, out) {
    const poId = ex.fields.po_number.value;
    if (!poId) {
      if (vendor && vendor.requires_po) out.push(C("po_missing", "block", "po_number", "PO required", `${vendor.name} is a PO vendor and this invoice has no PO number.`));
      return;
    }
    const o = master.pos[poId];
    if (!o) { out.push(C("po_unknown", "block", "po_number", "PO not found", `${poId} isn't in the purchasing system.`)); return; }
    if (o.vendor !== vid) { out.push(C("po_wrong_vendor", "block", "po_number", "PO belongs to another vendor", `${poId} was issued to ${master.vendors[o.vendor].name}.`)); return; }
    if (o.status !== "open") { out.push(C("po_closed", "block", "po_number", "PO is closed", `${poId} was closed on ${o.closed_on || "an earlier date"}.`)); return; }
    const tol = master.policy.price_tolerance_bps;
    ex.lines.forEach((l, i) => {
      const pl = o.lines.find(x => x.sku === l.sku);
      if (!pl) { out.push(C("po_line", "block", `line:${i}`, "Item isn't on the PO", `Line ${i + 1} (${l.sku || l.description}) isn't on ${poId}.`)); return; }
      if (l.unit_price * 10000 > pl.price * (10000 + tol)) {
        const pct = Math.floor((l.unit_price - pl.price) * 1000 / pl.price);
        out.push(C("po_price", "block", `line:${i}`, "Price above the PO", `${pl.sku}: billed ${fmt(l.unit_price, cur)}, PO price ${fmt(pl.price, cur)} (+${(pct / 10).toFixed(1)}%, tolerance ${(tol / 100).toFixed(0)}%).`));
      }
      let already = pl.billed;
      for (const p of prior) if (p.po === poId && ["needs_approval", "approved", "posted"].includes(p.status)) for (const x of p.lines) if (x.sku === pl.sku) already += x.qty;
      if (l.qty > pl.received - already) out.push(C("po_qty", "block", `line:${i}`, "Billed for more than received", `${pl.sku}: billed ${l.qty}, received ${pl.received}, already billed ${already}.`));
    });
  }
  function run(doc, ex, master, prior) {
    const policy = master.policy, f = ex.fields, out = [], text = pageText(doc);
    if (INJECTION.test(text)) out.push(C("injection", "block", null, "Instructions hidden in the document", "The page contains text addressed to an AI system. It was treated as data and ignored; a person should look at this one."));
    if (NOT_BILLS.includes(ex.doc_type)) {
      out.push(C("not_a_bill", "info", null, "Not a bill", `This is a ${label(ex.doc_type)}. Nothing to pay, so it's filed and routed.`));
      return out;
    }
    for (const k of REQUIRED) if (f[k].value === null || f[k].value === undefined || f[k].value === "") out.push(C("missing_field", "block", k, "Missing field", `${cap(label(k))} is required.`));
    grounding(doc, ex, policy, text, out);
    const m = matchVendor(f.vendor_name.value, f.tax_id.value, master), vid = m.id, vendor = master.vendors[m.id], cur = f.currency.value || "USD";
    if (m.how === "lookalike") {
      const like = master.vendors[m.like];
      out.push(C("vendor_lookalike", "block", "vendor_name", "Looks like a vendor you know, but isn't", `“${f.vendor_name.value}” is ${Math.round(m.score * 100)}% similar to ${like.name}, with a different tax ID and bank account.`));
    } else if (m.how === "none") out.push(C("vendor_unknown", "block", "vendor_name", "Unknown vendor", `“${f.vendor_name.value}” isn't in the vendor file. Onboard it before paying.`));
    if (vendor) {
      if (vendor.status === "blocked") out.push(C("vendor_blocked", "block", "vendor_name", "Vendor on hold", vendor.block_reason || "Payments to this vendor are on hold."));
      if (squash(f.bank_account.value) !== squash(vendor.bank)) out.push(C("bank_changed", "block", "bank_account", "Bank details changed", `The invoice pays to ${f.bank_account.value}; the vendor file has an account ending ${vendor.bank.slice(-4)}. Call the vendor on the number on file before paying.`));
      if (cur !== vendor.currency) out.push(C("currency", "block", "currency", "Wrong currency", `Billed in ${cur}; ${vendor.name} bills in ${vendor.currency}.`));
    }
    let dup = false;
    for (const p of prior) {
      if (p.status === "rejected") continue;
      if (p.sha256 === doc.sha256) { out.push(C("dup_exact", "block", "invoice_number", "Exact duplicate", `The same file was received as ${p.id}.`)); dup = true; break; }
      if (vid && p.vendor === vid && normNumber(p.number) === normNumber(f.invoice_number.value)) { out.push(C("dup_number", "block", "invoice_number", "Already received", `${p.id} has the same vendor and invoice number (${p.number}).`)); dup = true; break; }
    }
    if (!dup && vid) for (const p of prior) {
      if (p.status !== "rejected" && p.vendor === vid && p.total === f.total.value && p.date && f.invoice_date.value && Math.abs(daysBetween(p.date, f.invoice_date.value)) <= 7) {
        out.push(C("dup_soft", "warn", "total", "Possible duplicate", `${p.id} from this vendor has the same amount within a week.`));
        break;
      }
    }
    math(ex, cur, policy, out);
    const tax = f.tax.value || 0, sub = f.subtotal.value || 0;
    if (vendor && vendor.currency === cur) {
      const expected = Math.floor((sub * vendor.tax_bps + 5000) / 10000);
      if (Math.abs(tax - expected) > policy.math_tolerance_cents) out.push(C("tax_rate", "warn", "tax", "Tax doesn't match", `Expected ${fmt(expected, cur)} at ${(vendor.tax_bps / 100).toFixed(2)}%; billed ${fmt(tax, cur)}.`));
    }
    dates(ex, vendor, policy, out);
    if (ex.doc_type === "credit_note") out.push(C("credit_note", "info", null, "Credit note", "Reduces what you owe this vendor. A manager confirms it before it's applied."));
    else if (!dup && vendor) po(ex, vendor, vid, master, prior, cur, out);
    return out;
  }
  function route(ex, checks, master, overridden, changed) {
    overridden = overridden || [];
    const open = checks.filter(c => c.level !== "info" && !overridden.includes(c.id));
    if (checks.some(c => c.id === "not_a_bill")) return { status: "routed", approver: null };
    if (open.length) return { status: "exception", approver: null };
    const usd = Math.abs(amountUsd(ex, master)), limit = master.policy.auto_post_limit_cents, credit = ex.doc_type === "credit_note";
    if (usd <= limit && !credit && !overridden.length && !changed) return { status: "approved", approver: "auto" };
    const tiers = Object.entries(master.users).filter(([, u]) => u.limit_cents > 0).map(([k, u]) => [u.limit_cents, k]).sort((a, b) => a[0] - b[0]);
    const hit = tiers.find(([lim]) => usd <= lim);
    return { status: "needs_approval", approver: hit ? hit[1] : tiers[tiers.length - 1][1] };
  }
  const api = { money, day, daysBetween, normNumber, normName, squash, similarity, fmt, matchVendor, amountUsd, run, route, MONEY, DATES, NO_OVERRIDE };
  if (typeof module !== "undefined") module.exports = api; else root.Rules = api;
})(typeof window !== "undefined" ? window : globalThis);

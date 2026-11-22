/* Docket: the AP clerk's desk. Mirrors workflow.py in the browser; rules come from rules.js. */
const R = window.Rules, M = D.master, $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const KEY = "docket-v1", DEFAULT_POLICY = JSON.parse(JSON.stringify(M.policy));
const FIELDS = [["vendor_name", "Vendor"], ["tax_id", "Tax ID"], ["invoice_number", "Invoice no."], ["invoice_date", "Invoice date"], ["due_date", "Due date"], ["po_number", "PO number"], ["currency", "Currency"], ["subtotal", "Subtotal"], ["tax", "Tax"], ["shipping", "Freight"], ["total", "Total"], ["bank_account", "Pay to account"]];
const STATUS = { exception: "Problem", needs_approval: "To approve", approved: "Ready to post", on_hold: "On hold", posted: "Posted", routed: "Filed", rejected: "Rejected" };
const GROUPS = ["exception", "needs_approval", "approved", "on_hold", "posted", "routed", "rejected"];
const FILTERS = { all: "All", problems: "Problems", approve: "To approve", mine: "Mine", ready: "Ready", done: "Done" };
const CHECK_HELP = { dup_exact: "Reject it; the original is already in the queue.", dup_number: "Reject it, or correct the number if it was misread.", vendor_unknown: "Onboard the vendor first, or reject.", vendor_blocked: "Purchasing has this vendor on hold. Reject, or ask them to lift it.", po_unknown: "Correct the PO number, or reject.", po_wrong_vendor: "Correct the PO number, or reject.", po_closed: "Ask purchasing to reopen it, or reject.", po_line: "Correct the line, or reject.", missing_field: "Fill in the field." };

let S = { user: "maya", coach: true, items: {}, policy: null, outage: false }, filter = "all", search = "", active = null, capture = null, ledgerView = null, payloadKind = "qbo", posting = new Set();
const items = () => D.docs.map(d => S.items[d.id]);
const docOf = id => D.docs.find(d => d.id === id);
const me = () => M.users[S.user];
const clone = o => JSON.parse(JSON.stringify(o));

function summary(it) {
  const f = it.ex.fields;
  return { id: it.id, sha256: docOf(it.id).sha256, vendor: R.matchVendor(f.vendor_name.value, f.tax_id.value, M).id, number: f.invoice_number.value, total: f.total.value, date: f.invoice_date.value, po: f.po_number.value, lines: it.ex.lines, status: it.status };
}
function priorOf(it) { const out = []; for (const x of items()) { if (x === it) break; out.push(summary(x)); } return out; }
function log(it, who, action, detail) { it.log.push({ seq: it.log.length + 1, who, action, detail: detail || "", at: stamp() }); }
const stamp = () => new Date().toISOString().slice(0, 16).replace("T", " ");
function evaluate(it, quiet) {
  const before = it.status;
  it.checks = R.run(docOf(it.id), it.ex, M, priorOf(it));
  const live = new Set(it.checks.map(c => c.id));
  for (const k of Object.keys(it.overrides)) if (!live.has(k)) delete it.overrides[k];
  const r = R.route(it.ex, it.checks, M, Object.keys(it.overrides), it.editors.length > 0);
  it.status = r.status; it.approver = r.approver;
  it.approved_by = r.approver === "auto" ? "auto" : null;
  if (!quiet || before !== it.status) log(it, "system", "checked", `${STATUS[it.status]}; open: ${openChecks(it).map(c => c.id).join(", ") || "none"}`);
}
const openChecks = it => it.checks.filter(c => c.level !== "info" && !it.overrides[c.id]);
function reevalOpen() { for (const it of items()) if (it.status === "exception" || it.status === "needs_approval" || (it.status === "approved" && it.approved_by === "auto")) evaluate(it, true); }
function fresh() {
  S.items = {};
  for (const d of D.docs) {
    const it = S.items[d.id] = { id: d.id, ex: clone(d.raw), status: "received", approver: null, checks: [], overrides: {}, editors: [], log: [], posted_ref: null, approved_by: null };
    it.log.push({ seq: 1, who: "system", action: "received", detail: `${d.source} from ${d.sender}`, at: d.received_at.replace("T", " ") });
    it.log.push({ seq: 2, who: "model", action: "extracted", detail: "recorded extraction", at: d.received_at.replace("T", " ") });
    evaluate(it);
  }
}
function save() { try { localStorage.setItem(KEY, JSON.stringify({ ...S, policy: M.policy })); } catch (e) { } }
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { const o = JSON.parse(raw); if (D.docs.every(d => o.items[d.id])) { S = o; Object.assign(M.policy, o.policy || {}); return; } }
  } catch (e) { }
  fresh();
}
function toast(msg, bad) { const t = document.createElement("div"); t.className = "toast" + (bad ? " bad" : ""); t.textContent = msg; $("#toasts").append(t); setTimeout(() => t.remove(), bad ? 5000 : 2800); }
const cents = v => v === null || v === undefined ? "" : (v < 0 ? "-" : "") + Math.floor(Math.abs(v) / 100).toLocaleString("en-US") + "." + String(Math.abs(v) % 100).padStart(2, "0");
const amt = (v, c) => R.fmt(v || 0, c);
const shortDate = s => s ? new Date(s + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "";

/* ---------- actions (same rules as workflow.py) ---------- */
function act(fn) { const err = fn(); if (err) { toast(err, true); return false; } reevalOpen(); save(); render(); return true; }
function correct(id, field, raw) {
  const it = S.items[id], f = it.ex.fields[field];
  if (!["exception", "needs_approval"].includes(it.status)) return toast(`This document is ${STATUS[it.status].toLowerCase()}, so it can't be edited.`, true);
  let v = String(raw).trim();
  if (R.MONEY.includes(field)) { v = R.money(v); if (v === null) return toast("That isn't an amount.", true); }
  else if (R.DATES.includes(field)) { v = R.day(v); if (v === null) return toast("That isn't a date.", true); }
  else v = v || null;
  if (v === f.value) return;
  act(() => { const old = f.value; Object.assign(f, { value: v, edited: true, confidence: 1, evidence: String(v) }); delete f.implied; if (!it.editors.includes(S.user)) it.editors.push(S.user); log(it, S.user, "corrected", `${field}: ${old} → ${v}`); evaluate(it); });
}
function correctLine(id, i, k, raw) {
  const it = S.items[id], l = it.ex.lines[i];
  if (!["exception", "needs_approval"].includes(it.status)) return;
  let v = raw;
  if (k === "qty") { v = parseInt(raw, 10); if (isNaN(v)) return toast("That isn't a quantity.", true); }
  if (k === "unit_price" || k === "amount") { v = R.money(raw); if (v === null) return toast("That isn't an amount.", true); }
  if (v === l[k]) return;
  act(() => { log(it, S.user, "corrected", `line ${i + 1} ${k}: ${l[k] ?? "default"} → ${v}`); l[k] = v; if (!it.editors.includes(S.user)) it.editors.push(S.user); evaluate(it); });
}
function approveBlock(it) {
  if (it.status !== "needs_approval") return `It's ${STATUS[it.status].toLowerCase()}.`;
  if (it.editors.includes(S.user)) return "You changed this document, so someone else has to approve it.";
  const usd = Math.abs(R.amountUsd(it.ex, M));
  if (usd > me().limit_cents) return me().limit_cents ? `Above your approval limit of ${R.fmt(me().limit_cents)}.` : `${me().role}s can't approve. Switch to ${M.users[it.approver].name}.`;
  return null;
}
function approve(id) { const it = S.items[id], e = approveBlock(it); if (e) return toast(e, true); act(() => { it.status = "approved"; it.approved_by = S.user; log(it, S.user, "approved", R.fmt(Math.abs(R.amountUsd(it.ex, M)))); }); toast(`${id} approved.`); nextDoc(id); }
function overrideDlg(id, cid) {
  const it = S.items[id], c = it.checks.find(x => x.id === cid);
  if (!me().can_override.includes(cid)) return toast(`${me().role} can't override this. Switch to ${cid === "bank_changed" || cid === "period_closed" || cid === "vendor_lookalike" || cid === "po_missing" || cid === "date_future" ? "the Controller" : "a manager"}.`, true);
  const flds = [{ k: "reason", label: "Why is this OK?", area: 1 }];
  if (cid === "bank_changed") flds.push({ k: "ref", label: "Call-back reference (phone the number on file, not the one on the invoice)" });
  dialog(`Override: ${c.title}`, c.detail, flds, "Override", v => {
    if (!v.reason.trim()) return "Say why you're overriding this.";
    if (cid === "bank_changed" && !v.ref.trim()) return "Call the vendor on the number on file and enter the call reference first.";
    act(() => { it.overrides[cid] = { by: S.user, reason: v.reason, callback_ref: v.ref || null }; if (!it.editors.includes(S.user)) it.editors.push(S.user); log(it, S.user, "overrode", `${cid}: ${v.reason}${v.ref ? ` (call ref ${v.ref})` : ""}`); evaluate(it); });
  });
}
function rejectDlg(id) {
  const it = S.items[id]; if (!["exception", "needs_approval", "on_hold"].includes(it.status)) return;
  dialog(`Reject ${id}`, "It leaves the queue and won't be paid. The reason is kept in the audit trail.", [{ k: "reason", label: "Reason for the vendor", area: 1 }], "Reject", v => {
    if (!v.reason.trim()) return "Say why you're rejecting it.";
    act(() => { it.status = "rejected"; log(it, S.user, "rejected", v.reason); }); nextDoc(id);
  });
}
function holdDlg(id) {
  const it = S.items[id]; if (!["exception", "needs_approval"].includes(it.status)) return;
  dialog(`Put ${id} on hold`, "Use this while you wait for the vendor or purchasing.", [{ k: "reason", label: "What are you waiting for?" }], "Hold", v => { act(() => { it.status = "on_hold"; log(it, S.user, "held", v.reason); }); });
}
function release(id) { const it = S.items[id]; act(() => { log(it, S.user, "released"); evaluate(it); }); }
let nextRef = () => "BILL-" + (9001 + items().filter(x => x.posted_ref).length);
function postItem(id) {
  return new Promise(done => {
    const it = S.items[id]; if (it.status !== "approved" || posting.has(id)) return done(false);
    posting.add(id); render(); let tries = 0;
    const attempt = () => {
      tries++;
      setTimeout(() => {
        if (S.outage && tries < 4) { log(it, "system", "post failed", `503 from ledger, attempt ${tries}`); return attempt(); }
        posting.delete(id);
        if (S.outage) { toast(`${id}: the ledger is down. It stays ready to post; nothing was lost.`, true); save(); render(); return done(false); }
        it.posted_ref = nextRef(); it.status = "posted"; log(it, S.user, "posted", `${M.policy.ledger} ${it.posted_ref}`); save(); render(); done(true);
      }, 260);
    };
    attempt();
  });
}
async function postAll() { const ids = items().filter(x => x.status === "approved").map(x => x.id); let ok = 0; for (const id of ids) if (await postItem(id)) ok++; if (ok) toast(`Posted ${ok} bill${ok > 1 ? "s" : ""} to ${M.policy.ledger}.`); }
function nextDoc(id) { const list = visible(), i = list.findIndex(x => x.id === id), n = list[i + 1] || list[i - 1]; if (n && n.id !== id && S.items[id].status !== "exception") location.hash = "doc/" + n.id; }
function dialog(title, body, fields, ok, fn) {
  $("#modal").innerHTML = `<div class="bg"><form class="box"><h3>${esc(title)}</h3><p class="small" style="margin:0">${esc(body)}</p>${fields.map(f => `<label>${esc(f.label)}</label>${f.area ? `<textarea rows="2" name="${f.k}"></textarea>` : `<input name="${f.k}">`}`).join("")}<div class="err"></div><div class="acts"><button type="button" class="btn" data-x>Cancel</button><button class="btn go">${esc(ok)}</button></div></form></div>`;
  const form = $("#modal form"); form.querySelector("textarea,input").focus();
  form.querySelector("[data-x]").onclick = closeModal;
  form.onsubmit = e => { e.preventDefault(); const v = {}; fields.forEach(f => v[f.k] = form.elements[f.k].value); const err = fn(v); if (err) form.querySelector(".err").textContent = err; else closeModal(); };
}
function closeModal() { $("#modal").innerHTML = ""; }

/* ---------- the paper ---------- */
function locate(doc, ev) {
  if (!ev) return null; const want = R.squash(ev).split(" ");
  for (let p = 0; p < doc.pages.length; p++) {
    const t = doc.pages[p].tokens;
    for (let i = 0; i + want.length <= t.length; i++) if (want.every((w, k) => R.squash(t[i + k].t) === w)) return { p, i, n: want.length };
  }
  return null;
}
function box(page, hit) { const ts = page.tokens.slice(hit.i, hit.i + hit.n), x = Math.min(...ts.map(t => t.x)), y = Math.min(...ts.map(t => t.y)); return { x: x - 2, y: y - 1, w: Math.max(...ts.map(t => t.x + t.w)) - x + 4, h: Math.max(...ts.map(t => t.y + t.h)) - y + 2 }; }
function pageSvg(it, doc, pi) {
  const pg = doc.pages[pi], marks = [], probs = new Set(openChecks(it).map(c => c.field));
  for (const [k] of FIELDS) {
    const f = it.ex.fields[k]; if (!f || !f.evidence || f.edited) continue;
    const h = locate(doc, f.evidence); if (!h || h.p !== pi) continue;
    const b = box(pg, h), on = active === k;
    marks.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="1.5" fill="${on ? "rgba(245,200,66,.6)" : probs.has(k) ? "rgba(179,38,30,.13)" : "rgba(30,91,79,.07)"}" stroke="${probs.has(k) ? "#b3261e" : on ? "#b98900" : "none"}" stroke-width=".8"/>`);
  }
  const injected = it.checks.some(c => c.id === "injection");
  const tokens = pg.tokens.map((t, i) => {
    const faint = t.c < M.policy.ocr_floor, hidden = injected && t.s <= 6;
    return `<text x="${t.x}" y="${t.y + t.s}" font-size="${t.s}" font-weight="${t.b ? 700 : 400}" fill="${hidden ? "#b3261e" : t.f}" textLength="${t.w}" lengthAdjust="spacingAndGlyphs"${faint ? ' opacity=".4"' : ""}>${esc(t.t)}</text>`;
  }).join("");
  const hits = pg.tokens.map((t, i) => `<rect class="hit" data-p="${pi}" data-i="${i}" x="${t.x - 1}" y="${t.y - 1}" width="${t.w + 2}" height="${t.h + 1}"/>`).join("");
  const rects = pg.rects.map(r => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${r.f}"/>`).join("");
  return `<div class="page"><svg viewBox="0 0 ${pg.w} ${pg.h}" role="img" aria-label="Page ${pi + 1} of ${esc(doc.file)}">${rects}${marks.join("")}${tokens}${hits}</svg></div>`;
}

/* ---------- the desk ---------- */
function matches(it) {
  const f = it.ex.fields;
  if (search && !`${it.id} ${f.vendor_name.value} ${f.invoice_number.value} ${f.po_number.value || ""} ${cents(f.total.value)}`.toLowerCase().includes(search.toLowerCase())) return false;
  return { all: true, problems: it.status === "exception", approve: it.status === "needs_approval", ready: it.status === "approved", done: ["posted", "routed", "rejected"].includes(it.status),
    mine: S.user === "maya" ? it.status === "exception" : it.status === "needs_approval" ? !approveBlock(it) : it.status === "exception" && openChecks(it).some(c => me().can_override.includes(c.id)) }[filter];
}
const visible = () => GROUPS.flatMap(g => items().filter(x => x.status === g && matches(x)));
function tray(id) {
  const list = visible();
  const groups = GROUPS.map(g => { const xs = list.filter(x => x.status === g); return xs.length ? `<div class="grouph">${STATUS[g]} · ${xs.length}</div>` + xs.map(x => {
    const f = x.ex.fields, o = openChecks(x);
    return `<a class="row ${x.id === id ? "on" : ""}" href="#doc/${x.id}"><i class="dot d-${x.status}"></i><span class="v">${esc(f.vendor_name.value)}</span><span class="num small">${cents(f.total.value)}</span><span class="s">${x.id} · ${esc(f.invoice_number.value)}${x.status === "exception" ? " · " + esc(o[0] ? o[0].title : "") : x.approver && x.status === "needs_approval" ? " · " + esc(M.users[x.approver].name) : ""}</span></a>`;
  }).join("") : ""; }).join("");
  const coach = S.coach ? `<div class="coach"><b>Start here</b><ol><li>Open a <a href="#doc/${firstWith("not_on_page")}">misread total</a> and click the right number on the page.</li><li>Switch to Tom (top right) and approve it.</li><li>Post it from the <a href="#ledger">Ledger</a>.</li></ol><button class="link" data-coach>Got it</button> · <kbd>?</kbd> shortcuts</div>` : "";
  return `<section class="tray" aria-label="Document queue"><div class="trayhead"><input id="q" type="search" placeholder="Search vendor, number, amount  ( / )" value="${esc(search)}"><div class="chips">${Object.entries(FILTERS).map(([k, l]) => `<button class="chip ${filter === k ? "on" : ""}" data-filter="${k}">${l}</button>`).join("")}</div></div>${coach}<div class="list">${groups || `<div class="empty">Nothing here. ${filter === "problems" ? "Every problem is dealt with." : "Try another filter."}</div>`}</div></section>`;
}
const firstWith = c => (items().find(x => x.checks.some(k => k.id === c) && x.status === "exception") || items()[0]).id;
function desk(id) {
  if (!id || !S.items[id]) id = (visible()[0] || items()[0]).id;
  const it = S.items[id], doc = docOf(id), cur = it.ex.fields.currency.value;
  const editable = ["exception", "needs_approval"].includes(it.status);
  const badFields = new Set(openChecks(it).map(c => c.field));
  const probs = it.checks.filter(c => c.level !== "info" || c.id === "not_a_bill" || c.id === "credit_note").map(c => {
    const ov = it.overrides[c.id];
    if (ov) return `<div class="prob done"><b>${esc(c.title)}: overridden</b>${esc(M.users[ov.by].name)}: ${esc(ov.reason)}${ov.callback_ref ? ` (call ref ${esc(ov.callback_ref)})` : ""}</div>`;
    const canAct = it.status === "exception" && c.level !== "info";
    const blocked = R.NO_OVERRIDE.includes(c.id);
    return `<div class="prob ${c.level === "block" ? "" : c.level}"><b>${esc(c.title)}</b>${esc(c.detail)}${canAct ? `<div class="acts">${c.field && !c.field.startsWith("line") ? `<button class="link" data-goto="${c.field}">Show it</button>` : ""}${blocked ? `<span class="small">${esc(CHECK_HELP[c.id] || "")}</span>` : `<button class="link" data-over="${c.id}">Override…</button>`}</div>` : ""}</div>`;
  }).join("") || `<div class="prob done"><b>All checks passed</b>Vendor, bank, duplicates, arithmetic, dates${it.ex.fields.po_number.value ? " and the three-way PO match" : ""} are clean.</div>`;
  const fieldRows = FIELDS.map(([k, label]) => {
    const f = it.ex.fields[k], isM = R.MONEY.includes(k), v = isM ? cents(f.value) : f.value ?? "";
    const conf = badFields.has(k) ? "no" : (f.confidence ?? 1) < M.policy.confidence_floor ? "lo" : "";
    return `<div class="f ${badFields.has(k) ? "bad" : ""} ${f.edited ? "edited" : ""} ${active === k ? "active" : ""}" data-row="${k}"><label for="f-${k}">${label}</label><input id="f-${k}" data-f="${k}" value="${esc(v)}" ${editable ? "" : "readonly"} autocomplete="off" spellcheck="false" class="${isM ? "r" : ""}"><i class="conf ${conf}" title="${f.edited ? "Edited by hand" : `Model confidence ${Math.round((f.confidence ?? 1) * 100)}%`}"></i></div>`;
  }).join("");
  const vid = R.matchVendor(it.ex.fields.vendor_name.value, it.ex.fields.tax_id.value, M).id, v = M.vendors[vid], po = M.pos[it.ex.fields.po_number.value];
  const lineBad = new Set(openChecks(it).filter(c => c.field && c.field.startsWith("line:")).map(c => +c.field.split(":")[1]));
  const lines = it.ex.lines.map((l, i) => {
    const pl = po && po.lines.find(x => x.sku === l.sku), gl = l.gl || (pl && pl.gl) || (v && v.gl) || "6900";
    return `<tr class="${lineBad.has(i) ? "bad" : ""}"><td title="${esc(l.description)}" style="max-width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" class="small">${esc(l.description)}</td><td style="width:42px"><input data-l="${i}" data-k="qty" value="${l.qty}" ${editable ? "" : "readonly"}></td><td style="width:74px"><input data-l="${i}" data-k="unit_price" value="${cents(l.unit_price)}" ${editable ? "" : "readonly"}></td><td style="width:80px"><input data-l="${i}" data-k="amount" value="${cents(l.amount)}" ${editable ? "" : "readonly"}></td><td style="width:92px"><select data-l="${i}" data-k="gl" ${editable ? "" : "disabled"} aria-label="GL account">${Object.entries(M.gl).map(([c, n]) => `<option value="${c}" ${c === gl ? "selected" : ""} title="${esc(n)}">${c} ${esc(n.split(":").pop().trim().slice(0, 10))}</option>`).join("")}</select></td></tr>`;
  }).join("");
  const match3 = po ? `<h2>Three-way match · ${esc(it.ex.fields.po_number.value)}</h2><table class="small"><thead><tr><th>Item</th><th class="r">PO qty</th><th class="r">Received</th><th class="r">Billed</th><th class="r">PO price</th><th class="r">Invoice</th></tr></thead><tbody>${po.lines.map(pl => { const l = it.ex.lines.find(x => x.sku === pl.sku); const off = l && (l.qty > pl.received - pl.billed || l.unit_price * 10000 > pl.price * (10000 + M.policy.price_tolerance_bps)); return `<tr style="${off ? "color:var(--red);font-weight:600" : ""}"><td>${esc(pl.sku)}</td><td class="r num">${pl.qty}</td><td class="r num">${pl.received}</td><td class="r num">${l ? l.qty : 0}</td><td class="r num">${cents(pl.price)}</td><td class="r num">${l ? cents(l.unit_price) : "–"}</td></tr>`; }).join("")}</tbody></table>` : "";
  const ab = it.status === "needs_approval" ? approveBlock(it) : null;
  const foot = {
    exception: `<button class="btn no" data-do="reject">Reject <kbd>R</kbd></button><button class="btn" data-do="hold">Hold <kbd>H</kbd></button><span class="why">${openChecks(it).length} open. Fix the fields, or override with a reason.</span>`,
    needs_approval: `<button class="btn go" data-do="approve" ${ab ? "disabled" : ""}>Approve ${amt(it.ex.fields.total.value, cur)} <kbd>A</kbd></button><button class="btn no" data-do="reject">Reject</button><button class="btn" data-do="hold">Hold</button><span class="why">${ab ? esc(ab) : `Goes to ${esc(M.users[it.approver]?.name)}.`}</span>`,
    approved: `<button class="btn go" data-do="post" ${posting.has(id) ? "disabled" : ""}>${posting.has(id) ? "Posting…" : `Post to ${esc(M.policy.ledger)} <kbd>P</kbd>`}</button><span class="why">Approved by ${it.approved_by === "auto" ? "policy (clean and under the auto-post limit)" : esc(M.users[it.approved_by]?.name)}.</span>`,
    on_hold: `<button class="btn" data-do="release">Release and re-check</button><button class="btn no" data-do="reject">Reject</button>`,
    posted: `<span class="why">Posted as <b class="num">${esc(it.posted_ref)}</b>. <a href="#ledger">Open the ledger</a></span>`,
    routed: `<span class="why">Filed. Nothing to pay.</span>`, rejected: `<span class="why">Rejected. Kept for the record.</span>`
  }[it.status];
  const logRows = it.log.map(e => `<div><span class="mute">${esc(e.who === "system" || e.who === "model" ? e.who : M.users[e.who]?.name.split(" ")[0] || e.who)}</span><span>${esc(e.action)}${e.detail ? ": " + esc(e.detail) : ""}</span></div>`).join("");
  return `<div class="desk">${tray(id)}<section class="stage ${capture ? "capture" : ""}" aria-label="Document"><div class="stagebar"><span><b>${esc(doc.file)}</b> · ${esc(doc.source)} · ${esc(doc.sender)} · received ${esc(doc.received_at.replace("T", " "))}</span><span>${capture ? `<b style="color:var(--amber)">Click the word on the page for “${esc(FIELDS.find(x => x[0] === capture)[1])}”. Shift-click adds words.</b>` : '<span class="mute">Click a field, then click the value on the page</span>'} <a href="pdf/${esc(doc.file)}" target="_blank" rel="noopener">Open PDF</a></span></div>${doc.pages.map((_, i) => pageSvg(it, doc, i)).join("")}</section>
  <section class="sheet" aria-label="Coding sheet"><div class="sheethead"><span class="badge b-${it.status}">${STATUS[it.status]}</span> <span class="small mute">${id} · ${esc(it.ex.doc_type.replace("_", " "))}</span><h1>${esc(it.ex.fields.vendor_name.value)}</h1><span class="num">${amt(it.ex.fields.total.value, cur)}</span>${cur !== "USD" ? ` <span class="small mute">≈ ${R.fmt(R.amountUsd(it.ex, M), "USD")}</span>` : ""} <span class="small mute">· due ${shortDate(it.ex.fields.due_date.value)}${v ? ` · net ${v.terms}` : ""}</span></div>
  <div class="sheetbody">${probs}<h2>Header</h2>${fieldRows}<h2>Lines and coding</h2><table class="lines"><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Unit</th><th class="r">Amount</th><th>GL</th></tr></thead><tbody>${lines}</tbody></table>${match3}<h2>History</h2><div class="log">${logRows}</div></div><div class="foot">${foot}</div></section></div>`;
}

/* ---------- ledger ---------- */
function qbo(it) {
  const f = it.ex.fields, vid = R.matchVendor(f.vendor_name.value, f.tax_id.value, M).id, v = M.vendors[vid], po = M.pos[f.po_number.value];
  const gl = l => l.gl || (po && (po.lines.find(x => x.sku === l.sku) || {}).gl) || (v && v.gl) || "6900";
  const line = (a, d, g) => ({ DetailType: "AccountBasedExpenseLineDetail", Amount: a / 100, Description: d, AccountBasedExpenseLineDetail: { AccountRef: { value: g, name: M.gl[g] } } });
  const ls = it.ex.lines.map(l => line(l.amount, l.description, gl(l)));
  if (f.tax.value) ls.push(line(f.tax.value, "Sales tax", "6900")); if (f.shipping.value) ls.push(line(f.shipping.value, "Freight", "6100"));
  return { VendorRef: { value: vid, name: v ? v.name : f.vendor_name.value }, DocNumber: f.invoice_number.value, TxnDate: f.invoice_date.value, DueDate: f.due_date.value, CurrencyRef: { value: f.currency.value }, PrivateNote: `AP intake ${it.id}`, Line: ls };
}
function xero(it) {
  const f = it.ex.fields, q = qbo(it);
  return { Invoices: [{ Type: it.ex.doc_type === "credit_note" ? "ACCPAYCREDIT" : "ACCPAY", Contact: { Name: q.VendorRef.name }, InvoiceNumber: f.invoice_number.value, Date: f.invoice_date.value, DueDate: f.due_date.value, CurrencyCode: f.currency.value, Status: "AUTHORISED", LineAmountTypes: "Exclusive", LineItems: it.ex.lines.map((l, i) => ({ Description: l.description, Quantity: l.qty, UnitAmount: l.unit_price / 100, AccountCode: q.Line[i].AccountBasedExpenseLineDetail.AccountRef.value })) }] };
}
function ledger() {
  const ready = items().filter(x => x.status === "approved"), posted = items().filter(x => x.status === "posted");
  const usd = xs => xs.reduce((a, x) => a + R.amountUsd(x.ex, M), 0);
  const row = x => { const f = x.ex.fields; return `<tr class="c" data-pay="${x.id}"><td class="num">${x.posted_ref || x.id}</td><td>${esc(f.vendor_name.value)}</td><td class="num">${esc(f.invoice_number.value)}</td><td>${shortDate(f.invoice_date.value)}</td><td>${shortDate(f.due_date.value)}</td><td class="hs small">${x.approved_by === "auto" ? "Policy" : esc(M.users[x.approved_by]?.name || "")}</td><td class="r num">${amt(f.total.value, f.currency.value)}</td></tr>`; };
  const head = `<thead><tr><th>Ref</th><th>Vendor</th><th>Invoice</th><th>Date</th><th>Due</th><th class="hs">Approved by</th><th class="r">Amount</th></tr></thead>`;
  const sel = ledgerView && S.items[ledgerView];
  return `<div class="scroll"><div class="ledgerpage"><h1>Ledger</h1><p class="lede">Only approved bills reach ${esc(M.policy.ledger)}. Posting is idempotent, so a retry can't create a second bill.</p>
  <div class="figs"><div class="fig"><b>${ready.length}</b><span>ready to post</span></div><div class="fig"><b class="num" style="font-size:20px">${R.fmt(usd(ready))}</b><span>ready, in USD</span></div><div class="fig"><b>${posted.length}</b><span>posted</span></div><div class="fig"><b class="num" style="font-size:20px">${R.fmt(usd(posted))}</b><span>posted, in USD</span></div></div>
  <div class="tools"><button class="btn go" data-postall ${ready.length ? "" : "disabled"}>Post ${ready.length} to ${esc(M.policy.ledger)}</button><button class="btn" data-csv ${posted.length ? "" : "disabled"}>Export posted as CSV</button><label class="small"><input type="checkbox" data-outage ${S.outage ? "checked" : ""}> Simulate a ledger outage</label></div>
  <div class="two"><div><h2>Ready to post</h2>${ready.length ? `<table>${head}<tbody>${ready.map(row).join("")}</tbody></table>` : '<div class="empty">Nothing waiting. Approved bills appear here.</div>'}<h2>Posted</h2>${posted.length ? `<table>${head}<tbody>${posted.map(row).join("")}</tbody></table>` : '<div class="empty">Nothing posted yet. Post the bills above.</div>'}</div>
  <div><h2>Request ${sel ? "· " + sel.id : ""}</h2>${sel ? `<div class="chips" style="margin-bottom:5px"><button class="chip ${payloadKind === "qbo" ? "on" : ""}" data-kind="qbo">QuickBooks Bill</button><button class="chip ${payloadKind === "xero" ? "on" : ""}" data-kind="xero">Xero Invoice</button></div><pre>${esc(JSON.stringify(payloadKind === "qbo" ? qbo(sel) : xero(sel), null, 2))}</pre>` : '<div class="empty">Pick a bill to see exactly what is sent.</div>'}</div></div></div></div>`;
}
function csv() {
  const rows = [["ref", "doc", "vendor", "invoice", "date", "due", "currency", "total"]].concat(items().filter(x => x.status === "posted").map(x => { const f = x.ex.fields; return [x.posted_ref, x.id, f.vendor_name.value, f.invoice_number.value, f.invoice_date.value, f.due_date.value, f.currency.value, (f.total.value / 100).toFixed(2)]; }));
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n")], { type: "text/csv" })); a.download = "posted-bills.csv"; a.click();
}

/* ---------- records ---------- */
function vendors() {
  const rows = Object.entries(M.vendors).map(([id, v]) => {
    const xs = items().filter(x => R.matchVendor(x.ex.fields.vendor_name.value, x.ex.fields.tax_id.value, M).id === id), open = xs.filter(x => ["exception", "needs_approval", "on_hold"].includes(x.status)).length;
    return `<tr><td class="num small">${id}</td><td><b>${esc(v.name)}</b>${v.status === "blocked" ? ` <span class="badge b-exception">On hold</span><div class="small mute">${esc(v.block_reason)}</div>` : ""}</td><td class="num small">${esc(v.tax_id)}</td><td class="num small hs">····${esc(v.bank.slice(-4))}</td><td class="small">net ${v.terms}</td><td class="small">${v.currency}</td><td class="small">${v.requires_po ? "Required" : "–"}</td><td class="small hs">${esc(M.gl[v.gl])}</td><td class="r">${xs.length ? `<a href="#doc/${(xs.find(x => ["exception", "needs_approval"].includes(x.status)) || xs[0]).id}">${xs.length}${open ? ` (${open} open)` : ""}</a>` : "–"}</td></tr>`;
  }).join("");
  return `<div class="scroll"><div class="ledgerpage"><h1>Vendor file</h1><p class="lede">What every invoice is checked against. The bank account here is the only one Docket will pay; an invoice can't change it.</p><table><thead><tr><th>ID</th><th>Vendor</th><th>Tax ID</th><th class="hs">Bank</th><th>Terms</th><th>Cur.</th><th>PO</th><th class="hs">Default GL</th><th class="r">Docs</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}
function pos() {
  const rows = Object.entries(M.pos).map(([id, p]) => {
    const docs = items().filter(x => x.ex.fields.po_number.value === id);
    return `<h2>${id} · ${esc(M.vendors[p.vendor].name)} <span class="badge ${p.status === "open" ? "b-posted" : "b-routed"}">${p.status}</span> ${docs.map(d => `<a class="small" style="font-family:var(--sans);font-weight:400" href="#doc/${d.id}">${d.id}</a>`).join(" ")}</h2><table><thead><tr><th>Item</th><th>Description</th><th class="r">Ordered</th><th class="r">Received</th><th class="r">Billed before</th><th class="r">Price</th></tr></thead><tbody>${p.lines.map(l => `<tr><td class="num small">${esc(l.sku)}</td><td>${esc(l.desc)}</td><td class="r num">${l.qty}</td><td class="r num" style="${l.received < l.qty ? "color:var(--red);font-weight:600" : ""}">${l.received}</td><td class="r num">${l.billed}</td><td class="r num">${R.fmt(l.price, M.vendors[p.vendor].currency)}</td></tr>`).join("")}</tbody></table>`;
  }).join("");
  return `<div class="scroll"><div class="ledgerpage"><h1>Purchase orders and receipts</h1><p class="lede">The other two legs of the three-way match. Red means the goods haven't all arrived.</p>${rows}</div></div>`;
}
function accuracy() {
  const s = D.score, f = Object.entries(s.field_accuracy).sort((a, b) => a[1] - b[1]);
  const label = k => (FIELDS.find(x => x[0] === k) || [k, k])[1];
  const edits = items().reduce((a, x) => a + x.log.filter(e => e.action === "corrected").length, 0), ov = items().reduce((a, x) => a + Object.keys(x.overrides).length, 0);
  return `<div class="scroll"><div class="ledgerpage"><h1>How well it works</h1><p class="lede">Every document in this mailbox has hand-set truth. These numbers come from running the recorded model output through the real checks, on every build.</p>
  <div class="figs"><div class="fig"><b>${s.planted_caught} of ${s.planted}</b><span>planted problems caught</span></div><div class="fig"><b>${s.false_alarms}</b><span>false alarms on ${s.clean} clean bills</span></div><div class="fig"><b>${s.wrong_through}</b><span>wrong model values that could post</span></div><div class="fig"><b>${s.straight_through} of ${s.bills}</b><span>bills needed nobody</span></div></div>
  <div class="two"><div><h2>What the model read correctly, by field</h2><table><tbody>${f.map(([k, v]) => `<tr><td>${esc(label(k))}</td><td style="width:50%"><div class="bar"><i style="width:${v * 100}%;${v < 1 ? "background:var(--amber)" : ""}"></i></div></td><td class="r num">${(v * 100).toFixed(1)}%</td></tr>`).join("")}</tbody></table><p class="small mute">The model is deliberately wrong on some documents, so the checks have something to catch. In this session: ${edits} field correction${edits === 1 ? "" : "s"}, ${ov} override${ov === 1 ? "" : "s"}.</p></div>
  <div><h2>Each document</h2><table><thead><tr><th>Doc</th><th>Case</th><th>Route</th></tr></thead><tbody>${s.rows.map(r => `<tr class="c" onclick="location.hash='doc/${r.id}'"><td class="num small">${r.id}</td><td class="small">${esc(r.title)}${r.model_wrong.length ? ' <span class="badge b-needs_approval">model wrong</span>' : ""}</td><td class="small">${r.ok ? '<span style="color:var(--green)">✓</span>' : "✕"} ${STATUS[r.got]}</td></tr>`).join("")}</tbody></table></div></div></div></div>`;
}
function audit() {
  const rows = items().flatMap(x => x.log.map(e => ({ ...e, id: x.id }))).filter(e => e.who !== "system" && e.who !== "model" || ["posted"].includes(e.action));
  const sys = items().reduce((a, x) => a + x.log.length, 0);
  return `<div class="scroll"><div class="ledgerpage"><h1>Audit trail</h1><p class="lede">Who changed what, and why. The service keeps this as a hash chain, so an edited history is detectable. ${sys} entries in total; people's actions are below.</p>${rows.length ? `<table><thead><tr><th>When</th><th>Who</th><th>Doc</th><th>Action</th><th>Detail</th></tr></thead><tbody>${rows.reverse().map(e => `<tr class="c" onclick="location.hash='doc/${e.id}'"><td class="num small">${esc(e.at)}</td><td>${esc(M.users[e.who]?.name || e.who)}</td><td class="num small">${e.id}</td><td>${esc(e.action)}</td><td class="small">${esc(e.detail)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">No one has touched a document yet. <a href="#doc/${firstWith("not_on_page")}">Fix the first one</a>.</div>`}</div></div>`;
}
function settings() {
  const P = M.policy, row = (k, t, d, type, val) => `<div class="set"><div><b>${t}</b><p>${d}</p></div><input data-set="${k}" type="${type}" value="${val}"></div>`;
  return `<div class="scroll"><div class="ledgerpage" style="max-width:760px"><h1>Policy</h1><p class="lede">The rules your controller owns. Changing one re-checks the open queue straight away.</p>
  ${row("auto_post_limit_cents", "Auto-post limit (USD)", "Clean bills up to this amount need no person.", "number", P.auto_post_limit_cents / 100)}
  ${row("price_tolerance_bps", "PO price tolerance (%)", "How far above the PO price an invoice may be.", "number", P.price_tolerance_bps / 100)}
  ${row("confidence_floor", "Minimum model confidence", "Below this, a person compares the field with the page.", "number", P.confidence_floor)}
  ${row("closed_through", "Books closed through", "Invoices dated on or before this need a Controller.", "date", P.closed_through)}
  ${row("stale_days", "Old-invoice warning (days)", "Flag invoices older than this.", "number", P.stale_days)}
  <div class="set"><div><b>Accounting system</b><p>Where approved bills are posted. Add your keys in the service's environment.</p></div><select data-set="ledger">${["QuickBooks Online", "Xero"].map(x => `<option ${P.ledger === x ? "selected" : ""}>${x}</option>`).join("")}</select></div>
  <h2>People and limits</h2><table><thead><tr><th>Name</th><th>Role</th><th class="r">Approval limit</th><th>Can override</th></tr></thead><tbody>${Object.values(M.users).map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.role)}</td><td class="r num">${u.limit_cents ? R.fmt(u.limit_cents) : "–"}</td><td class="small">${u.can_override.length ? (u.can_override.includes("bank_changed") ? "Everything overridable, including bank changes" : "Arithmetic, tax, PO variances, dates") : "Nothing; fixes fields and sends for approval"}</td></tr>`).join("")}</tbody></table>
  <h2>Demo</h2><p class="small">Your changes are kept in this browser.</p><button class="btn no" data-reset>Reset the demo</button></div></div>`;
}

/* ---------- shell ---------- */
const TABS = [["queue", "Desk"], ["ledger", "Ledger"], ["vendors", "Vendors"], ["pos", "Purchase orders"], ["accuracy", "Accuracy"], ["audit", "Audit trail"], ["settings", "Policy"]];
function topbar(v) {
  const n = items().filter(x => x.status === "exception" || x.status === "needs_approval").length;
  $("#top").innerHTML = `<div class="brand">Docket<small>Accounts payable · Alder &amp; Finch</small></div><nav class="tabs">${TABS.map(([k, l]) => `<a href="#${k}" class="${(v === k || (v === "doc" && k === "queue")) ? "on" : ""}">${l}${k === "queue" && n ? `<b>${n}</b>` : ""}</a>`).join("")}</nav><div class="who"><label for="user" class="mute">Working as</label><select id="user">${Object.entries(M.users).map(([k, u]) => `<option value="${k}" ${k === S.user ? "selected" : ""}>${esc(u.name)}, ${esc(u.role)}</option>`).join("")}</select><button class="iconbtn" data-theme title="Light or dark">◐</button><button class="iconbtn" data-help title="Keyboard shortcuts">?</button></div>`;
}
let lastHash = "";
function render() {
  const [v, arg] = decodeURIComponent(location.hash.slice(1) || "queue").split("/");
  if (v === "queue" && arg && FILTERS[arg]) filter = arg;
  const keep = {}; if (lastHash === location.hash) for (const s of [".list", ".stage", ".sheetbody", ".scroll"]) { const el = $(s); if (el) keep[s] = el.scrollTop; }
  topbar(v);
  $("#main").innerHTML = v === "doc" ? desk(arg) : ({ ledger, vendors, pos, accuracy, audit, settings }[v] || desk)(v === "queue" ? undefined : arg);
  for (const s in keep) { const el = $(s); if (el) el.scrollTop = keep[s]; }
  lastHash = location.hash;
  document.title = v === "doc" ? `${arg} · Docket` : "Docket: AP intake";
}
const curId = () => { const r = $(".row.on"); return r ? r.getAttribute("href").slice(5) : null; };

document.addEventListener("click", e => {
  const t = e.target, id = curId();
  const hit = t.closest && t.closest(".hit");
  if (hit && capture && id) {
    const tok = docOf(id).pages[+hit.dataset.p].tokens[+hit.dataset.i], inp = $(`[data-f="${capture}"]`), field = capture;
    if (e.shiftKey && inp) { inp.value = (inp.value + " " + tok.t).trim(); inp.focus(); return; }
    capture = null; correct(id, field, tok.t); return;
  }
  const b = t.closest && t.closest("button,[data-pay]"); if (!b) return;
  if (b.dataset.filter) { filter = b.dataset.filter; if (location.hash.startsWith("#queue")) location.hash = "queue"; render(); }
  else if (b.dataset.do) ({ approve: () => approve(id), reject: () => rejectDlg(id), hold: () => holdDlg(id), release: () => release(id), post: () => postItem(id).then(ok => ok && toast(`${id} posted.`)) })[b.dataset.do]();
  else if (b.dataset.over) overrideDlg(id, b.dataset.over);
  else if (b.dataset.goto) { active = b.dataset.goto; capture = active; render(); const el = $(`[data-f="${active}"]`); if (el) { el.focus(); el.select(); } }
  else if ("coach" in b.dataset) { S.coach = false; save(); render(); }
  else if ("help" in b.dataset) help();
  else if ("theme" in b.dataset) flip();
  else if ("postall" in b.dataset) postAll();
  else if ("csv" in b.dataset) csv();
  else if (b.dataset.pay) { ledgerView = b.dataset.pay; render(); }
  else if (b.dataset.kind) { payloadKind = b.dataset.kind; render(); }
  else if ("reset" in b.dataset) { Object.assign(M.policy, DEFAULT_POLICY); S = { user: "maya", coach: true, items: {}, policy: null, outage: false }; try { localStorage.removeItem(KEY); } catch (x) { } fresh(); filter = "all"; location.hash = "queue"; render(); toast("Demo reset."); }
});
function markField(k) {
  $$(".livemark").forEach(x => x.remove());
  const id = curId(); if (!id || !k) return;
  const doc = docOf(id), f = S.items[id].ex.fields[k], h = f && locate(doc, f.evidence); if (!h) return;
  const svg = $$(".page svg")[h.p], b = box(doc.pages[h.p], h), r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  for (const [a, v] of Object.entries({ x: b.x, y: b.y, width: b.w, height: b.h, rx: 1.5, fill: "rgba(245,200,66,.55)", stroke: "#b98900", "stroke-width": .8, class: "livemark", "pointer-events": "none" })) r.setAttribute(a, v);
  svg.append(r);
  const page = svg.closest(".page"), st = $(".stage"), y = page.offsetTop - st.offsetTop + b.y / doc.pages[h.p].h * page.offsetHeight;
  if (y < st.scrollTop + 30 || y > st.scrollTop + st.clientHeight - 40) st.scrollTo({ top: Math.max(0, y - st.clientHeight / 2), behavior: "smooth" });
}
document.addEventListener("mouseover", e => { const row = e.target.closest && e.target.closest("[data-row]"); if (row) markField(row.dataset.row); });
document.addEventListener("mouseout", e => { const row = e.target.closest && e.target.closest("[data-row]"); if (row && !row.contains(e.relatedTarget)) markField(active); });
document.addEventListener("focusin", e => { if (e.target.dataset && e.target.dataset.f) markField(e.target.dataset.f); });
document.addEventListener("focusin", e => { const k = e.target.dataset && e.target.dataset.f; if (k && !e.target.readOnly) { active = k; capture = k; $$(".f.active").forEach(x => x.classList.remove("active")); e.target.closest(".f").classList.add("active"); const st = $(".stage"); if (st) st.classList.add("capture"); } });
document.addEventListener("change", e => {
  const t = e.target, id = curId();
  if (t.id === "user") { S.user = t.value; save(); render(); toast(`Working as ${me().name}, ${me().role}.`); return; }
  if (t.dataset.outage !== undefined) { S.outage = t.checked; save(); return; }
  if (t.dataset.set) { const k = t.dataset.set; let v = t.value; if (k === "auto_post_limit_cents") v = Math.round(+v * 100); if (k === "price_tolerance_bps") v = Math.round(+v * 100); if (k === "confidence_floor") v = +v; if (k === "stale_days") v = +v; M.policy[k] = v; reevalOpen(); save(); render(); toast("Policy saved. Open documents re-checked."); return; }
  if (t.dataset.f && id) { const k = t.dataset.f, v = t.value; setTimeout(() => { const next = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.f : null; correct(id, k, v); if (next) { const el = $(`[data-f="${next}"]`); if (el) el.focus(); } }, 0); }
  if (t.dataset.l !== undefined && id) correctLine(id, +t.dataset.l, t.dataset.k, t.value);
});
document.addEventListener("input", e => { if (e.target.id === "q") { search = e.target.value; const pos = e.target.selectionStart; render(); const q = $("#q"); q.focus(); q.setSelectionRange(pos, pos); } });
document.addEventListener("keydown", e => {
  const inField = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
  if (e.key === "Escape") { if ($("#modal").innerHTML) closeModal(); else if (inField) e.target.blur(); capture = null; active = null; const st = $(".stage"); if (st) st.classList.remove("capture"); return; }
  if (inField && e.key === "Enter" && e.target.dataset.f) { e.target.blur(); return; }
  if (inField || e.metaKey || e.ctrlKey || $("#modal").innerHTML) return;
  const id = curId();
  if (e.key === "/") { e.preventDefault(); const q = $("#q"); if (q) q.focus(); }
  else if (e.key === "?") help();
  else if (!id) return;
  else if (e.key === "j" || e.key === "k") { const l = visible(), i = l.findIndex(x => x.id === id), n = l[i + (e.key === "j" ? 1 : -1)]; if (n) location.hash = "doc/" + n.id; }
  else if (e.key === "a") approve(id);
  else if (e.key === "r") rejectDlg(id);
  else if (e.key === "h") holdDlg(id);
  else if (e.key === "p") postItem(id).then(ok => ok && toast(`${id} posted.`));
});
function help() {
  $("#modal").innerHTML = `<div class="bg"><div class="box"><h3>Keyboard</h3><table><tbody>${[["J / K", "Next / previous document"], ["A", "Approve"], ["R", "Reject"], ["H", "Hold"], ["P", "Post"], ["/", "Search"], ["Click a field, then a word", "Fill the field from the page"], ["Shift-click", "Add another word"], ["Enter", "Save the field"], ["Esc", "Close, or stop capturing"]].map(([k, d]) => `<tr><td><kbd>${k}</kbd></td><td>${d}</td></tr>`).join("")}</tbody></table><div class="acts"><button class="btn" onclick="closeModal()">Close</button></div></div></div>`;
}
function flip() { const r = document.documentElement, dark = r.dataset.theme ? r.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; r.dataset.theme = dark ? "light" : "dark"; try { localStorage.setItem("docket-theme", r.dataset.theme); } catch (e) { } }
try { const t = localStorage.getItem("docket-theme"); if (t) document.documentElement.dataset.theme = t; } catch (e) { }
window.addEventListener("hashchange", () => { capture = null; active = null; render(); });
load(); render();

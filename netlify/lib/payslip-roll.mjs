// Repeat a payslip into the following week(s). The weekly figures stay the same; dates, period numbers
// and every "to date" total move forward. Used when a business's payslips rarely change.
const num = (x) => { const n = parseFloat(String(x === undefined || x === null ? '' : x).replace(/[,€\s]/g, '')); return isFinite(n) ? n : null; };
const money = (n) => (Math.round(n * 100) / 100).toFixed(2);
const addDays = (iso, d) => { const t = new Date(iso + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function rollSlip(prev, weeks) {
  const s = JSON.parse(JSON.stringify(prev)), n = weeks;
  s.ready = true; s.auto = true;
  const per = num(prev.period);
  if (per !== null && /^\d+$/.test(String(prev.period).trim())) s.period = String(per + n);
  if (ISO.test(String(prev.payDate || ''))) s.payDate = addDays(prev.payDate, 7 * n);
  const iw = num(prev.insurWk); if (iw !== null && /^\d+$/.test(String(prev.insurWk).trim())) s.insurWk = String(iw + n);
  const gross = num(prev.gross) || 0;
  (s.de || []).forEach((r) => { const v = num(r.v), t = num(r.tot); if (v !== null && t !== null && t > 0) r.tot = money(t + n * v); });
  // Totals that follow pay: gross, taxable and non-tax deductions keep their share of gross.
  const cg = num(prev.cGross);
  if (cg !== null) {
    s.cGross = money(cg + n * gross);
    const ct = num(prev.cTaxable); if (ct !== null && cg > 0) s.cTaxable = money(ct + n * gross * (ct / cg));
    const cn = num(prev.cNonTaxDeds); if (cn !== null && cg > 0) s.cNonTaxDeds = money(cn + n * gross * (cn / cg));
  }
  const taxRow = (prev.de || []).find((r) => /^tax$/i.test(String(r.d || '').trim()));
  const ctt = num(prev.cTotalTax); if (ctt !== null && taxRow && num(taxRow.v) !== null) s.cTotalTax = money(ctt + n * num(taxRow.v));
  // Credits and cut-off build up by the same amount each period.
  ['cTaxCredit', 'cCutOff'].forEach((k) => { const v = num(prev[k]); if (v !== null && per) s[k] = money(v + n * v / per); });
  const tp = num(prev.taxCreditTP), ctc = num(prev.cTaxCredit);
  if (tp !== null) s.taxCreditTP = ctc !== null && Math.abs(tp - ctc) < 0.01 ? s.cTaxCredit : per ? money(tp + n * tp / per) : prev.taxCreditTP;
  const ep = num(prev.erPrsiPer), etd = num(prev.erPrsiTD); if (ep !== null && etd !== null) s.erPrsiTD = money(etd + n * ep);
  return s;
}

// For every employee with an approved payslip, make sure the week being paid (the one holding `payDay`) has one.
// Returns the number of payslips added; changes `doc` in place.
export function rollAll(doc, payDay) {
  const st = ((doc.settings || {}).main) || {};
  if (st.slipAuto === false) return 0;
  const d = new Date(payDay + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const target = d.toISOString().slice(0, 10);
  let added = 0;
  Object.keys(doc.staff || {}).forEach((sid) => {
    const stf = doc.staff[sid];
    if ((stf.leaves || []).some((l) => l.from <= target && (!l.to || l.to >= target))) return;
    if (doc.weeks[target] && doc.weeks[target].slips && doc.weeks[target].slips[sid]) return;
    let base = null, bw = null;
    Object.keys(doc.weeks || {}).sort().forEach((w) => { const x = doc.weeks[w].slips && doc.weeks[w].slips[sid]; if (w < target && x && x.ready) { base = x; bw = w; } });
    if (!base) return;
    const n = Math.round((Date.parse(target) - Date.parse(bw)) / (7 * 86400000));
    if (n < 1 || n > 8) return;
    const w = doc.weeks[target] || (doc.weeks[target] = { cfg: doc.weeks[bw].cfg || { lunch: 0, otAfter: 40, otPremium: 0 }, snap: {}, shifts: [], cash: {}, off: {} });
    w.slips = w.slips || {};
    w.slips[sid] = rollSlip(base, n);
    added++;
  });
  return added;
}

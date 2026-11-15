// A payslip as a one-page A4 PDF. The figures are exactly what the employer entered from their payroll.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const NAVY = rgb(0.055, 0.102, 0.18), BRASS = rgb(0.725, 0.541, 0.2), INK = rgb(0.063, 0.094, 0.157);
const MUTED = rgb(0.37, 0.4, 0.45), LINE = rgb(0.88, 0.87, 0.84), PAPER = rgb(0.965, 0.957, 0.937), WHITE = rgb(1, 1, 1);

const fmtDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return String(s || '');
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

export async function payslipPdf(sl, wid, opts = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle('Payslip ' + (sl.fullName || '') + ' ' + wid);
  doc.setAuthor(sl.company || 'My Shifts');
  doc.setCreator('My Shifts');
  const page = doc.addPage([595.28, 841.89]);
  const R = await doc.embedFont(StandardFonts.Helvetica), B = await doc.embedFont(StandardFonts.HelveticaBold);
  const okChars = new Set(R.getCharacterSet());
  // Keep only what the PDF font can draw; letters it cannot draw become "?".
  const safe = (v) => Array.from(String(v === undefined || v === null ? '' : v)).map((c) => (okChars.has(c.codePointAt(0)) ? c : c === '’' ? "'" : '?')).join('');
  const W = 595.28, M = 40;
  const text = (s, x, y, size, font, color, align) => {
    s = safe(s); if (!s) return;
    const w = font.widthOfTextAtSize(s, size);
    const xx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    page.drawText(s, { x: xx, y, size, font, color: color || INK });
  };
  const fit = (s, font, size, max) => { s = safe(s); while (s.length > 1 && font.widthOfTextAtSize(s, size) > max) s = s.slice(0, -2) + '…'.replace('…', '.'); return s; };
  const line = (x1, y1, x2, y2, c) => page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.7, color: c || LINE });

  // Header band
  page.drawRectangle({ x: 0, y: 841.89 - 96, width: W, height: 96, color: NAVY });
  page.drawRectangle({ x: M, y: 841.89 - 66, width: 30, height: 30, color: BRASS });
  text((safe(sl.company || 'P').trim().charAt(0) || 'P').toUpperCase(), M + 15, 841.89 - 59, 17, B, NAVY, 'center');
  text(fit(sl.company || 'Payslip', B, 18, 330), M + 42, 841.89 - 52, 18, B, WHITE);
  text('PAYSLIP', W - M, 841.89 - 46, 11, B, BRASS, 'right');
  text('Week starting ' + fmtDate(wid), W - M, 841.89 - 62, 10, R, rgb(0.85, 0.82, 0.74), 'right');

  // Employee details
  let y = 841.89 - 128;
  const pps = String(sl.pps || '');
  const ppsShown = opts.fullPps ? pps : pps.length > 4 ? '****' + pps.slice(-4) : pps;
  const details = [['Name', sl.fullName], ['PPS No.', ppsShown], ['Pay date', fmtDate(sl.payDate)], ['Period', sl.period], ['Freq.', sl.freq], ['Number', sl.number], ['Dept', sl.dept], ['Pay method', sl.method]].filter((r) => String(r[1] || '') !== '');
  const colW = (W - 2 * M) / 2;
  details.forEach((r, i) => {
    const x = M + (i % 2) * colW, yy = y - Math.floor(i / 2) * 30;
    text(r[0].toUpperCase(), x, yy + 10, 7.5, B, MUTED);
    text(fit(r[1], B, 11.5, colW - 16), x, yy - 4, 11.5, B, INK);
  });
  y -= Math.ceil(details.length / 2) * 30 + 14;
  line(M, y, W - M, y);

  // Two tables side by side: pay elements and deductions
  y -= 26;
  const tW = (W - 2 * M - 16) / 2, xL = M, xR = M + tW + 16;
  const table = (x, title, cols, rows) => {
    let yy = y;
    text(title.toUpperCase(), x, yy, 8.5, B, MUTED); yy -= 14;
    page.drawRectangle({ x, y: yy - 6, width: tW, height: 18, color: PAPER });
    cols.forEach((c) => text(c.h, c.right ? x + c.x : x + c.x, yy, 8, B, MUTED, c.right ? 'right' : 'left'));
    yy -= 20;
    if (!rows.length) { text('None', x + 6, yy, 9.5, R, MUTED); yy -= 18; }
    rows.forEach((r) => {
      cols.forEach((c, i) => text(i === 0 ? fit(r[i], R, 9.5, c.w || 90) : r[i], c.right ? x + c.x : x + c.x, yy, 9.5, i === 0 ? R : R, INK, c.right ? 'right' : 'left'));
      yy -= 6; line(x, yy, x + tW, yy); yy -= 12;
    });
    return yy;
  };
  const el = (sl.el || []).filter((r) => r && (r.d || r.v || r.h)), de = (sl.de || []).filter((r) => r && (r.d || r.v || r.tot));
  const yL = table(xL, 'Pay elements', [{ h: 'Description', x: 6, w: 100 }, { h: 'Tax', x: 120 }, { h: 'Hours', x: tW - 70, right: true }, { h: 'Value', x: tW - 6, right: true }], el.map((r) => [r.d, r.t, r.h, r.v]));
  const yR = table(xR, 'Deductions', [{ h: 'Description', x: 6, w: 96 }, { h: 'Tax', x: 112 }, { h: 'Value', x: tW - 70, right: true }, { h: 'Total', x: tW - 6, right: true }], de.map((r) => [r.d, r.t, r.v, r.tot]));
  y = Math.min(yL, yR) - 14;

  // Summary with the take-home figure on navy
  const boxH = 74;
  page.drawRectangle({ x: M, y: y - boxH, width: W - 2 * M, height: boxH, color: PAPER });
  const sums = [['Gross pay', sl.gross], ['Total deductions', sl.totalDeds], ['Non-tax adj.', sl.nonTaxAdjs], ['Rounding', sl.rounding]];
  sums.forEach((r, i) => { const x = M + 14 + i * 88; text(r[0].toUpperCase(), x, y - 26, 7, B, MUTED); text(r[1] || '-', x, y - 44, 13, B, INK); });
  const nx = W - M - 150;
  page.drawRectangle({ x: nx, y: y - boxH, width: 150, height: boxH, color: NAVY });
  text('NETT PAY', nx + 14, y - 26, 8, B, BRASS);
  text(sl.nett ? (/^[0-9.,]+$/.test(String(sl.nett)) ? '€' + sl.nett : sl.nett) : '-', nx + 14, y - 52, 22, B, WHITE);
  y -= boxH + 26;

  // Year to date and tax details
  const kv = (x, title, rows) => {
    let yy = y;
    text(title.toUpperCase(), x, yy, 8.5, B, MUTED); yy -= 18;
    rows.forEach((r) => { text(r[0], x, yy, 9.5, R, MUTED); text(r[1] || '-', x + tW, yy, 9.5, B, INK, 'right'); yy -= 6; line(x, yy, x + tW, yy); yy -= 12; });
    return yy;
  };
  const y1 = kv(xL, 'Cumulative details', [['Gross pay', sl.cGross], ['Non-tax deductions', sl.cNonTaxDeds], ['Taxable pay', sl.cTaxable], ['Tax credit to date', sl.cTaxCredit], ['Cut-off to date', sl.cCutOff], ['Total tax', sl.cTotalTax]]);
  const y2 = kv(xR, 'Tax / PRSI', [['Tax code', sl.taxCode], ['Emergency start period', sl.emerStart], ['Tax credit this period', sl.taxCreditTP], ['Pay rel. code', sl.payRel], ['Total insurable weeks', sl.insurWk], ["Employer PRSI this period", sl.erPrsiPer], ["Employer PRSI to date", sl.erPrsiTD]]);
  y = Math.min(y1, y2) - 12;

  const para = (title, body) => {
    if (!body) return;
    text(title.toUpperCase(), M, y, 8.5, B, MUTED); y -= 15;
    const words = safe(body).split(/\s+/); let cur = '';
    words.forEach((w) => { const t = cur ? cur + ' ' + w : w; if (R.widthOfTextAtSize(t, 9.5) > W - 2 * M) { text(cur, M, y, 9.5, R, INK); y -= 13; cur = w; } else cur = t; });
    if (cur) { text(cur, M, y, 9.5, R, INK); y -= 18; }
  };
  para('Comments', sl.comments); para('Notes', sl.notes);

  // Footer
  line(M, 48, W - M, 48);
  text('Issued by ' + (sl.company || 'your employer') + ' through My Shifts. Figures entered by your employer from their payroll.', M, 34, 7.5, R, MUTED);
  text('Questions about this payslip go to your employer.', M, 23, 7.5, R, MUTED);
  return Buffer.from(await doc.save());
}

export const payslipFileName = (sl, wid) => 'Payslip-' + String(sl.fullName || 'employee').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + wid + '.pdf';

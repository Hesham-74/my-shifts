// Runs every hour. At the hour the manager chose (in their own time zone) it sends
// "record today's hours" to the manager's phone(s).
import webpush from 'web-push';
import { storesFor, globalStore, allCompanies, phoneKey } from '../lib/tenant.mjs';
import { payslipPdf, payslipFileName } from '../lib/payslip-pdf.mjs';

async function send(subs, payload, v, subject) {
  let n = 0;
  for (const sub of subs || []) {
    try { await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 86400, urgency: 'high', vapidDetails: { subject, publicKey: v.publicKey, privateKey: v.privateKey } }); n++; } catch (e) { /* skip a dead phone */ }
  }
  return n;
}
function localNow(tz) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  const date = new Date(Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day'))));
  return { date, hour: Number(get('hour')) % 24, dow: date.getUTCDay(), day: date.toISOString().slice(0, 10) };
}

const FROM_DOMAIN = process.env.MAIL_FROM_DOMAIN || 'mail.myshifts.info';
const h = (x) => String(x === undefined || x === null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// The payslip as an email. The PPS number is shortened here; the full payslip is in the staff app.
function slipEmail(sl, wid) {
  const td = 'padding:6px 8px;border-bottom:1px solid #e3e8ef;font:14px Arial,Helvetica,sans-serif;color:#14213a';
  const kv = (rows) => '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">' + rows.map((r) => '<tr><td style="' + td + ';color:#566580">' + h(r[0]) + '</td><td align="right" style="' + td + ';font-weight:bold">' + h(r[1]) + '</td></tr>').join('') + '</table>';
  const head = (t) => '<p style="font:bold 12px Arial,Helvetica,sans-serif;letter-spacing:1px;text-transform:uppercase;color:#566580;margin:18px 0 6px">' + h(t) + '</p>';
  const grid = (cols, rows) => '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse"><tr>' + cols.map((c) => '<td style="' + td + ';color:#566580;font-size:12px">' + h(c) + '</td>').join('') + '</tr>' + rows.map((r) => '<tr>' + r.map((c) => '<td style="' + td + '">' + h(c) + '</td>').join('') + '</tr>').join('') + '</table>';
  const pps = String(sl.pps || ''), ppsShort = pps.length > 4 ? '•••• ' + pps.slice(-4) : pps;
  const el = (sl.el || []).filter((r) => r && (r.d || r.v || r.h)), de = (sl.de || []).filter((r) => r && (r.d || r.v || r.tot));
  return '<div style="max-width:560px;margin:0 auto;padding:16px">' +
    '<p style="font:bold 18px Arial,Helvetica,sans-serif;color:#14213a;margin:0 0 4px">' + h(sl.company || 'Payslip') + '</p>' +
    '<p style="font:14px Arial,Helvetica,sans-serif;color:#566580;margin:0 0 12px">Payslip for the week starting ' + h(wid) + '</p>' +
    kv([['Name', sl.fullName], ['PPS No.', ppsShort], ['Number', sl.number], ['Dept', sl.dept], ['Freq.', sl.freq], ['Period', sl.period], ['Pay Date', sl.payDate]].filter((r) => String(r[1] || '') !== '')) +
    head('Pay Elements') + grid(['Description', 'Tax', 'Hours', 'Value'], el.map((r) => [r.d, r.t, r.h, r.v])) +
    head('Deductions') + grid(['Description', 'Tax', 'Value', 'Total'], de.map((r) => [r.d, r.t, r.v, r.tot])) +
    head('Summary') + kv([['Gross Pay', sl.gross], ['Total Deds', sl.totalDeds], ['Non-Tax Adjs', sl.nonTaxAdjs], ['Rounding', sl.rounding], ['Nett Pay', sl.nett], ['Pay Method', sl.method]]) +
    head('Cumulative Details') + kv([['Gross Pay', sl.cGross], ['Non-Tax Deds', sl.cNonTaxDeds], ['Taxable Pay', sl.cTaxable], ['Tax Credit T.D', sl.cTaxCredit], ['Cut-Off T.D', sl.cCutOff], ['Total Tax', sl.cTotalTax]]) +
    head('Tax/PRSI') + kv([['Tax Code', sl.taxCode], ['Emer. Start Per.', sl.emerStart], ['Tax Credit T.P', sl.taxCreditTP], ['Pay Rel. Code', sl.payRel], ['Total Insur. Wk.', sl.insurWk], ['Emp’er PRSI Per.', sl.erPrsiPer], ['Emp’er PRSI TD.', sl.erPrsiTD]]) +
    (sl.comments ? head('Comments') + '<p style="font:14px Arial,Helvetica,sans-serif;color:#14213a;margin:0">' + h(sl.comments) + '</p>' : '') +
    (sl.notes ? head('Notes') + '<p style="font:14px Arial,Helvetica,sans-serif;color:#14213a;margin:0">' + h(sl.notes) + '</p>' : '') +
    '<p style="font:12px Arial,Helvetica,sans-serif;color:#566580;margin:20px 0 0">Sent for ' + h(sl.company || 'your employer') + ' by My Shifts. The figures were entered by your employer. Questions about this payslip go to your employer.</p></div>';
}
// The payslip goes as a PDF attachment, with a short note in the email itself.
async function mailSlip(to, sl, wid) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !/^\S+@\S+\.\S+$/.test(String(to || ''))) return false;
  const name = String(sl.company || 'Payslips').replace(/[<>"\r\n]/g, '').slice(0, 60);
  try {
    const pdf = await payslipPdf(sl, wid);
    const html = '<div style="font:15px Arial,Helvetica,sans-serif;color:#14213a;max-width:520px;margin:0 auto;padding:16px">' +
      '<p style="margin:0 0 12px">Hi ' + h(String(sl.fullName || '').split(' ')[0] || 'there') + ',</p>' +
      '<p style="margin:0 0 12px">Your payslip for the week starting ' + h(wid) + ' is attached as a PDF.' + (sl.nett ? ' Nett pay: <strong>' + h(/^[0-9.,]+$/.test(String(sl.nett)) ? '€' + sl.nett : sl.nett) + '</strong>.' : '') + '</p>' +
      '<p style="margin:0;color:#566580;font-size:13px">Sent for ' + h(sl.company || 'your employer') + ' by My Shifts. Questions about this payslip go to your employer.</p></div>';
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: name + ' <payslips@' + FROM_DOMAIN + '>', to: [String(to).trim()], subject: 'Your payslip, week starting ' + wid, html,
        attachments: [{ filename: payslipFileName(sl, wid), content: pdf.toString('base64') }] }) });
    return r.ok;
  } catch (e) { return false; }
}

// Payslips: the day before the chosen day the owner is told; on the day, every payslip marked ready is released to its employee.
async function payslips(S, doc, v, subject) {
  const cfg = S.config;
  const st = ((doc && doc.settings) || {}).main || {};
  if (!doc || st.slipDay === undefined || st.slipDay === '' || st.slipDay === null) return 'slips off';
  const now = localNow(st.tz), day = Number(st.slipDay), hour = Number(st.slipHour) || 0;
  if (now.hour !== hour) return 'slips wait';
  const ready = [];
  Object.keys(doc.weeks || {}).forEach((wid) => { const sl = doc.weeks[wid].slips || {}; Object.keys(sl).forEach((sid) => { if (sl[sid] && sl[sid].ready && doc.staff[sid]) ready.push({ wid, sid, slip: sl[sid] }); }); });
  const store = S.payslips;
  const lists = {};
  const listOf = async (k) => lists[k] || (lists[k] = (await store.get(k, { type: 'json' })) || []);
  if (now.dow === (day + 6) % 7) {
    const mark = await cfg.get('slipnote', { type: 'json' });
    if (mark && mark.day === now.day) return 'slips noted';
    let waiting = 0;
    for (const r of ready) { const k = phoneKey(doc.staff[r.sid].phone); if (k.length >= 7 && !(await listOf(k)).some((x) => x.wid === r.wid)) waiting++; }
    const rem = await cfg.get('remind', { type: 'json' });
    await send(rem && rem.subs, { title: 'Weekly Staff Pay', body: waiting ? 'Tomorrow ' + waiting + (waiting === 1 ? ' payslip goes' : ' payslips go') + ' out to your staff. Check them today.' : 'Payslips go out tomorrow, but none is marked ready yet.', tag: 'slips' }, v, subject);
    await cfg.setJSON('slipnote', { day: now.day });
    return 'slips notice ' + waiting;
  }
  if (now.dow !== day) return 'slips not today';
  const subs = S.subs;
  let out = 0, mailed = 0;
  for (const r of ready) {
    const stf = doc.staff[r.sid], k = phoneKey(stf.phone); if (k.length < 7) continue;
    const list = await listOf(k);
    const entry = { wid: r.wid, slip: { ...r.slip, fullName: (stf.pay && stf.pay.fullName) || stf.name, pps: (stf.pay && stf.pay.pps) || '', company: st.company || '' } };
    const at = list.findIndex((x) => x.wid === r.wid);
    const email = stf.pay && stf.pay.email;
    if (at > -1) {
      let changed = false;
      if (JSON.stringify(list[at].slip) !== JSON.stringify(entry.slip)) { list[at] = { ...entry, at: list[at].at, mailed: list[at].mailed }; changed = true; }
      if (!list[at].mailed && email && await mailSlip(email, entry.slip, r.wid)) { list[at].mailed = true; changed = true; mailed++; }
      if (changed) await store.setJSON(k, list);
      continue;
    }
    const sentMail = email ? await mailSlip(email, entry.slip, r.wid) : false; if (sentMail) mailed++;
    list.push({ ...entry, at: new Date().toISOString(), mailed: sentMail }); list.sort((a, b) => b.wid.localeCompare(a.wid));
    await store.setJSON(k, list.slice(0, 80)); out++;
    await send(await subs.get(k, { type: 'json' }), { title: 'My Shifts', body: 'Your payslip is ready. Tap to see it.' }, v, subject);
  }
  return 'slips out ' + out + ' mailed ' + mailed;
}

// Every business, one after another. One business failing never stops the others.
export default async () => {
  const v = await globalStore('config').get('vapid', { type: 'json' });
  const subject = process.env.URL || 'https://my-shifts-app.netlify.app';
  const out = [];
  for (const cid of await allCompanies()) {
    const S = storesFor(cid);
    let slipsResult = '', hoursResult = '';
    try { if (v) slipsResult = await payslips(S, await S.backup.get('latest', { type: 'json' }), v, subject); } catch (e) { slipsResult = 'slips error'; }
    try { hoursResult = await (await hours(S, v, subject)).text(); } catch (e) { hoursResult = 'hours error'; }
    out.push(cid + ': ' + hoursResult + ' | ' + slipsResult);
  }
  return new Response(out.join('\n'));
};

async function hours(S, v, subject) {
  const cfg = S.config;
  const r = await cfg.get('remind', { type: 'json' });
  if (!r || !r.subs || !r.subs.length) return new Response('off');
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: r.tz || 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  const hour = Number(get('hour')) % 24, stamp = get('year') + '-' + get('month') + '-' + get('day') + 'T' + hour;
  if (hour !== (r.hour || 0) || r.last === stamp) return new Response('not now');
  if (!v) return new Response('no key');
  // Who still has nothing recorded for the working day (before noon the reminder is about yesterday).
  let extra = '';
  try {
    const doc = await S.backup.get('latest', { type: 'json' });
    if (doc) {
      const base = new Date(Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day'))));
      if (hour < 12) base.setUTCDate(base.getUTCDate() - 1);
      const day = base.toISOString().slice(0, 10);
      const mon = new Date(base); mon.setUTCDate(mon.getUTCDate() - ((mon.getUTCDay() + 6) % 7));
      const w = (doc.weeks || {})[mon.toISOString().slice(0, 10)] || {};
      const worked = {}; (w.shifts || []).forEach((x) => { if (x.date === day && x.in) worked[x.sid] = 1; });
      const off = (w.off || {})[day] || [];
      const missing = Object.keys(doc.staff || {}).filter((sid) => {
        const st = doc.staff[sid];
        const away = (st.leaves || []).some((l) => l.from <= day && (!l.to || l.to >= day));
        return !away && !worked[sid] && off.indexOf(sid) < 0;
      }).map((sid) => doc.staff[sid].name);
      const label = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(base);
      extra = missing.length ? ' Nothing recorded for ' + label + ': ' + missing.slice(0, 12).join(', ') + (missing.length > 12 ? ' and more' : '') + '.' : ' Everyone has hours or a day off for ' + label + '.';
    }
  } catch (e) { extra = ''; }
  const payload = JSON.stringify({ title: 'Weekly Staff Pay', body: 'Time to record the hours.' + extra, tag: 'hours' });
  const keep = [];
  for (const sub of r.subs) {
    try { await webpush.sendNotification(sub, payload, { TTL: 6 * 3600, urgency: 'high', vapidDetails: { subject, publicKey: v.publicKey, privateKey: v.privateKey } }); keep.push(sub); }
    catch (e) { if (!(e && (e.statusCode === 404 || e.statusCode === 410))) keep.push(sub); }
  }
  await cfg.setJSON('remind', { ...r, subs: keep, last: stamp });
  return new Response('sent ' + keep.length);
};


export const config = { schedule: '0 * * * *' };

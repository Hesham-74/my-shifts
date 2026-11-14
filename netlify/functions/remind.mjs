// Runs every hour. At the hour the manager chose (in their own time zone) it sends
// "record today's hours" to the manager's phone(s).
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';

const phoneKey = (p) => { const d = String(p == null ? '' : p).replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : d; };

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

// Payslips: the day before the chosen day the owner is told; on the day, every payslip marked ready is released to its employee.
async function payslips(cfg, doc, v, subject) {
  const st = ((doc && doc.settings) || {}).main || {};
  if (!doc || st.slipDay === undefined || st.slipDay === '' || st.slipDay === null) return 'slips off';
  const now = localNow(st.tz), day = Number(st.slipDay), hour = Number(st.slipHour) || 0;
  if (now.hour !== hour) return 'slips wait';
  const ready = [];
  Object.keys(doc.weeks || {}).forEach((wid) => { const sl = doc.weeks[wid].slips || {}; Object.keys(sl).forEach((sid) => { if (sl[sid] && sl[sid].ready && doc.staff[sid]) ready.push({ wid, sid, slip: sl[sid] }); }); });
  const store = getStore({ name: 'payslips', consistency: 'strong' });
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
  const subs = getStore({ name: 'subs', consistency: 'strong' });
  let out = 0;
  for (const r of ready) {
    const stf = doc.staff[r.sid], k = phoneKey(stf.phone); if (k.length < 7) continue;
    const list = await listOf(k);
    const entry = { wid: r.wid, slip: { ...r.slip, fullName: (stf.pay && stf.pay.fullName) || stf.name, pps: (stf.pay && stf.pay.pps) || '', company: st.company || '' } };
    const at = list.findIndex((x) => x.wid === r.wid);
    if (at > -1) { if (JSON.stringify(list[at].slip) !== JSON.stringify(entry.slip)) { list[at] = { ...entry, at: list[at].at }; await store.setJSON(k, list); } continue; }
    list.push({ ...entry, at: new Date().toISOString() }); list.sort((a, b) => b.wid.localeCompare(a.wid));
    await store.setJSON(k, list.slice(0, 80)); out++;
    await send(await subs.get(k, { type: 'json' }), { title: 'My Shifts', body: 'Your payslip is ready. Tap to see it.' }, v, subject);
  }
  return 'slips out ' + out;
}

export default async () => {
  const cfg = getStore({ name: 'config', consistency: 'strong' });
  const v = await cfg.get('vapid', { type: 'json' });
  const subject = process.env.URL || 'https://my-shifts-app.netlify.app';
  let slipsResult = '';
  try { if (v) slipsResult = await payslips(cfg, await getStore({ name: 'backup', consistency: 'strong' }).get('latest', { type: 'json' }), v, subject); } catch (e) { slipsResult = 'slips error'; }
  const res = await hours(cfg, v, subject);
  return new Response((await res.text()) + ' | ' + slipsResult);
};

async function hours(cfg, v, subject) {
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
    const doc = await getStore({ name: 'backup', consistency: 'strong' }).get('latest', { type: 'json' });
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

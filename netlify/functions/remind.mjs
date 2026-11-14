// Runs every hour. At the hour the manager chose (in their own time zone) it sends
// "record today's hours" to the manager's phone(s).
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';

export default async () => {
  const cfg = getStore({ name: 'config', consistency: 'strong' });
  const r = await cfg.get('remind', { type: 'json' });
  if (!r || !r.subs || !r.subs.length) return new Response('off');
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: r.tz || 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  const hour = Number(get('hour')) % 24, stamp = get('year') + '-' + get('month') + '-' + get('day') + 'T' + hour;
  if (hour !== (r.hour || 0) || r.last === stamp) return new Response('not now');
  const v = await cfg.get('vapid', { type: 'json' });
  if (!v) return new Response('no key');
  const subject = process.env.URL || 'https://my-shifts-app.netlify.app';
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

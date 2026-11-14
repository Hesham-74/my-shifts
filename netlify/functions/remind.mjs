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
  const payload = JSON.stringify({ title: 'Weekly Staff Pay', body: 'Time to record today’s hours.', tag: 'hours' });
  const keep = [];
  for (const sub of r.subs) {
    try { await webpush.sendNotification(sub, payload, { TTL: 6 * 3600, urgency: 'high', vapidDetails: { subject, publicKey: v.publicKey, privateKey: v.privateKey } }); keep.push(sub); }
    catch (e) { if (!(e && (e.statusCode === 404 || e.statusCode === 410))) keep.push(sub); }
  }
  await cfg.setJSON('remind', { ...r, subs: keep, last: stamp });
  return new Response('sent ' + keep.length);
};

export const config = { schedule: '0 * * * *' };

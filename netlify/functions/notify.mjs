// Every 5 minutes: staff whose coming shifts changed are told once the manager has stopped editing for 30 minutes.
import webpush from 'web-push';
import { storesFor, globalStore, allCompanies } from '../lib/tenant.mjs';

const QUIET = 30 * 60000;

export default async () => {
  const v = await globalStore('config').get('vapid', { type: 'json' });
  if (!v) return new Response('no key');
  const subject = process.env.URL || 'https://my-shifts-app.netlify.app';
  const payload = JSON.stringify({ title: 'My Shifts', body: 'Your work times changed. Tap to see them.' });
  const out = [];
  for (const cid of await allCompanies()) {
    try {
      const S = storesFor(cid);
      const pq = await S.config.get('pending', { type: 'json' });
      const keys = Object.keys((pq && pq.keys) || {});
      if (!keys.length || !pq.last || Date.now() - pq.last < QUIET) continue;
      let sent = 0;
      for (const k of keys) {
        const list = (await S.subs.get(k, { type: 'json' })) || [], keep = [];
        for (const sub of list) {
          try { await webpush.sendNotification(sub, payload, { TTL: 86400, urgency: 'high', vapidDetails: { subject, publicKey: v.publicKey, privateKey: v.privateKey } }); keep.push(sub); sent++; }
          catch (e) { if (!(e && (e.statusCode === 404 || e.statusCode === 410))) keep.push(sub); }
        }
        if (keep.length !== list.length) await S.subs.setJSON(k, keep);
      }
      await S.config.setJSON('pending', { keys: {}, last: null, sentAt: Date.now() });
      out.push(cid + ': ' + keys.length + ' people, ' + sent + ' sent');
    } catch (e) { out.push(cid + ': error'); }
  }
  return new Response(out.join('\n') || 'nothing to send');
};

export const config = { schedule: '*/5 * * * *' };

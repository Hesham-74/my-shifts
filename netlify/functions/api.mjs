// Small server for the staff apps.
//   POST /api/enter                employee: is this phone on the list, and does it have a code yet?
//   POST /api/setpin               employee: create their own code (only when none is set)
//   GET  /api/schedule?phone=...   employee (phone + their code): days and times (never pay)
//   POST /api/nudge                manager: ask one employee, or everyone, to check their times
//   POST /api/admin-remind         manager: turn the daily "record the hours" reminder on or off for this phone
//   POST /api/resetpin             manager: clear one employee's code so they can make a new one
//   POST /api/login                manager: first call sets the password, later calls check it
//   PUT  /api/sync                 manager: replace all schedules + save a full private backup
//   GET  /api/backup               manager: read the latest backup
//   GET  /api/status               manager: who has seen their latest change, who has notifications on
//   GET  /api/push-key             anyone: public key for notifications
//   POST /api/subscribe            employee: turn notifications on for this phone
//   POST /api/seen                 employee: "I have opened my current times"
import { getStore } from '@netlify/blobs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import webpush from 'web-push';

const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
const phoneKey = (p) => { const d = String(p == null ? '' : p).replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : d; };
const hashOf = (token, salt) => createHash('sha256').update(salt + ':' + token).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^\d{2}:\d{2}$/;

// Keep only what an employee may see, whatever the manager app sent.
function cleanSchedule(s) {
  const shifts = (Array.isArray(s && s.shifts) ? s.shifts : [])
    .filter((x) => x && DATE.test(x.d) && TIME.test(x.i))
    .slice(0, 400)
    .map((x) => ({ d: x.d, i: x.i, o: TIME.test(x.o) ? x.o : '' }));
  const off = (Array.isArray(s && s.off) ? s.off : []).filter((d) => DATE.test(d)).slice(0, 400);
  return { name: String((s && s.name) || '').slice(0, 80), shifts, off };
}
// The part of a schedule an employee should be told about: today and later.
const futureSig = (s, today) => JSON.stringify([s.shifts.filter((x) => x.d >= today), s.off.filter((d) => d >= today)]);
const fullSig = (s) => JSON.stringify([s.name, s.shifts, s.off]);

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\//, '').replace(/\/+$/, '');
  const cfg = getStore({ name: 'config', consistency: 'strong' });
  const sch = getStore({ name: 'schedules', consistency: 'strong' });
  const bak = getStore({ name: 'backup', consistency: 'strong' });
  const subs = getStore({ name: 'subs', consistency: 'strong' });
  const seen = getStore({ name: 'seen', consistency: 'strong' });
  const pins = getStore({ name: 'pins', consistency: 'strong' });

  // Employee check: 'ok', 'setpin' (no code yet), 'wrongpin', or 'locked' (too many wrong tries).
  const staffAuth = async (k) => {
    const pin = await pins.get(k, { type: 'json' });
    if (!pin) return 'setpin';
    if (pin.lockUntil && Date.now() < pin.lockUntil) return 'locked';
    const t = tokenOf();
    if (!t) return 'wrongpin';
    { const x = Buffer.from(hashOf(t, pin.salt)), y = Buffer.from(pin.hash); if (x.length === y.length && timingSafeEqual(x, y)) { if (pin.fails) await pins.setJSON(k, { salt: pin.salt, hash: pin.hash, fails: 0 }); return 'ok'; } }
    const fails = (pin.fails || 0) + 1;
    await pins.setJSON(k, { salt: pin.salt, hash: pin.hash, fails: fails >= 5 ? 0 : fails, lockUntil: fails >= 5 ? Date.now() + 15 * 60000 : 0 });
    await sleep(800);
    return 'wrongpin';
  };
  const denied = (why) => json({ error: why }, why === 'locked' ? 429 : 401);

  const vapid = async () => {
    let v = await cfg.get('vapid', { type: 'json' });
    if (!v) { v = webpush.generateVAPIDKeys(); await cfg.setJSON('vapid', v); }
    return v;
  };
  const notify = async (k, text) => {
    const list = (await subs.get(k, { type: 'json' })) || [];
    if (!list.length) return 0;
    const v = await vapid();
    const payload = JSON.stringify({ title: 'My Shifts', body: text || 'Your work times changed. Tap to see them.' });
    const keep = []; let sent = 0;
    for (const sub of list) {
      try {
        await webpush.sendNotification(sub, payload, { TTL: 86400, urgency: 'high', vapidDetails: { subject: url.origin, publicKey: v.publicKey, privateKey: v.privateKey } });
        keep.push(sub); sent++;
      } catch (e) { if (!(e && (e.statusCode === 404 || e.statusCode === 410))) keep.push(sub); }
    }
    if (keep.length !== list.length) await subs.setJSON(k, keep);
    return sent;
  };
  const statusOf = async (keys) => {
    const out = {};
    for (const k of keys) {
      const d = await sch.get(k, { type: 'json' }); if (!d) continue;
      const sn = await seen.get(k, { type: 'json' });
      const sl = (await subs.get(k, { type: 'json' })) || [];
      out[k] = { pin: !!(await pins.get(k, { type: 'json' })), chg: d.chg || null, seen: sn && sn.upd === d.upd ? sn.at : null, lastSeen: sn ? sn.at : null, push: sl.length > 0 };
    }
    return out;
  };

  const tokenOf = () => { const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.get('authorization') || ''); return m ? m[1] : ''; };
  const isAdmin = async () => {
    const t = tokenOf(); if (!t) return false;
    const a = await cfg.get('admin', { type: 'json' }); if (!a) return false;
    const x = Buffer.from(hashOf(t, a.salt)), y = Buffer.from(a.hash);
    return x.length === y.length && timingSafeEqual(x, y);
  };

  try {
    if (path === 'schedule' && req.method === 'GET') {
      const k = phoneKey(url.searchParams.get('phone'));
      if (k.length < 7) return json({ error: 'badphone' }, 400);
      const d = await sch.get(k, { type: 'json' });
      if (!d) return json({ error: 'notfound' }, 404);
      const a = await staffAuth(k); if (a !== 'ok') return denied(a);
      return json(d);
    }

    if (path === 'enter' && req.method === 'POST') {
      const body = JSON.parse((await req.text()).slice(0, 300));
      const k = phoneKey(body.phone);
      if (k.length < 7 || !(await sch.get(k, { type: 'json' }))) return json({ error: 'notfound' }, 404);
      return json({ ok: true, hasPin: !!(await pins.get(k, { type: 'json' })) });
    }

    if (path === 'setpin' && req.method === 'POST') {
      const body = JSON.parse((await req.text()).slice(0, 300));
      const k = phoneKey(body.phone), t = tokenOf();
      if (k.length < 7 || !t) return json({ error: 'bad' }, 400);
      if (!(await sch.get(k, { type: 'json' }))) return json({ error: 'notfound' }, 404);
      if (await pins.get(k, { type: 'json' })) return json({ error: 'haspin' }, 409);
      const salt = randomBytes(16).toString('hex');
      await pins.setJSON(k, { salt, hash: hashOf(t, salt), fails: 0 });
      return json({ ok: true });
    }

    if (path === 'nudge' && req.method === 'POST') {
      if (!(await isAdmin())) { await sleep(1200); return json({ error: 'wrongpassword' }, 401); }
      const body = JSON.parse((await req.text()).slice(0, 300));
      let keys;
      if (body.phone) keys = [phoneKey(body.phone)]; else keys = (await sch.list()).blobs.map((b) => b.key);
      let sent = 0, off = 0;
      for (const k of keys) { const n = await notify(k, 'Your manager asks you to check your work times.'); if (n) sent++; else off++; }
      return json({ ok: true, sent, off });
    }

    if (path === 'admin-remind' && req.method === 'POST') {
      if (!(await isAdmin())) { await sleep(1200); return json({ error: 'wrongpassword' }, 401); }
      const body = JSON.parse((await req.text()).slice(0, 5000));
      const cur = (await cfg.get('remind', { type: 'json' })) || { subs: [] };
      const sub = body.sub;
      if (body.off) {
        cur.subs = (cur.subs || []).filter((x) => !sub || x.endpoint !== sub.endpoint);
        if (!sub) cur.subs = [];
        await cfg.setJSON('remind', cur);
        return json({ ok: true, on: false });
      }
      if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return json({ error: 'bad' }, 400);
      const hour = Math.min(23, Math.max(0, parseInt(body.hour, 10) || 0));
      let tz = 'UTC'; try { new Intl.DateTimeFormat('en-GB', { timeZone: String(body.tz) }); tz = String(body.tz); } catch (e) { tz = 'UTC'; }
      const clean = { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } };
      cur.subs = (cur.subs || []).filter((x) => x.endpoint !== clean.endpoint).concat([clean]).slice(-5);
      cur.hour = hour; cur.tz = tz;
      await cfg.setJSON('remind', cur);
      const v = await vapid();
      try { await webpush.sendNotification(clean, JSON.stringify({ title: 'Weekly Staff Pay', body: 'Daily reminder is on. You will be reminded at ' + String(hour).padStart(2, '0') + ':00.', tag: 'hours' }), { TTL: 3600, vapidDetails: { subject: url.origin, publicKey: v.publicKey, privateKey: v.privateKey } }); } catch (e) { /* the saved reminder still stands */ }
      return json({ ok: true, on: true, hour, tz });
    }

    if (path === 'resetpin' && req.method === 'POST') {
      if (!(await isAdmin())) { await sleep(1200); return json({ error: 'wrongpassword' }, 401); }
      const body = JSON.parse((await req.text()).slice(0, 300));
      const k = phoneKey(body.phone);
      await pins.delete(k); await subs.delete(k);
      return json({ ok: true, status: await statusOf([k]) });
    }

    if (path === 'login' && req.method === 'POST') {
      const t = tokenOf(); if (!t) return json({ error: 'badtoken' }, 400);
      const a = await cfg.get('admin', { type: 'json' });
      if (!a) {
        const salt = randomBytes(16).toString('hex');
        await cfg.setJSON('admin', { salt, hash: hashOf(t, salt), created: new Date().toISOString() });
        return json({ ok: true, created: true, hasBackup: false });
      }
      if (!(await isAdmin())) { await sleep(1200); return json({ error: 'wrongpassword' }, 401); }
      const meta = await bak.get('meta', { type: 'json' });
      return json({ ok: true, created: false, hasBackup: !!meta, backupAt: meta ? meta.at : null });
    }

    if (path === 'sync' && req.method === 'PUT') {
      if (!(await isAdmin())) { await sleep(1200); return json({ error: 'wrongpassword' }, 401); }
      const text = await req.text();
      if (text.length > 3000000) return json({ error: 'toolarge' }, 413);
      const body = JSON.parse(text);
      const want = {};
      Object.keys(body.schedules || {}).slice(0, 300).forEach((p) => { const k = phoneKey(p); if (k.length >= 7 && !want[k]) want[k] = cleanSchedule(body.schedules[p]); });
      const { blobs } = await sch.list();
      for (const b of blobs) if (!want[b.key]) { await sch.delete(b.key); await subs.delete(b.key); await seen.delete(b.key); await pins.delete(b.key); }
      const now = new Date().toISOString();
      const today = DATE.test(body.today) ? body.today : now.slice(0, 10);
      let notified = 0;
      for (const k of Object.keys(want)) {
        const prev = await sch.get(k, { type: 'json' });
        const next = want[k];
        if (prev && fullSig(prev) === fullSig(next)) continue;            // nothing changed for this person
        next.upd = now;
        next.chg = prev ? prev.chg || null : null;
        const changedAhead = prev ? futureSig(prev, today) !== futureSig(next, today) : (next.shifts.some((x) => x.d >= today) || next.off.some((d) => d >= today));
        if (changedAhead) { next.chg = now; }
        await sch.setJSON(k, next);
        if (changedAhead && prev) { try { notified += await notify(k); } catch (e) { /* a failed notification never blocks saving */ } }
      }
      let backedUp = false;
      const bk = body.backup;
      if (bk && typeof bk.staff === 'object' && typeof bk.weeks === 'object' && (Object.keys(bk.staff).length || Object.keys(bk.weeks).length)) {
        const at = new Date().toISOString();
        const doc = { app: 'weekly-staff-pay', version: 1, exportedAt: at, staff: bk.staff, weeks: bk.weeks };
        await bak.setJSON('latest', doc);
        await bak.setJSON('day-' + at.slice(0, 10), doc);
        await bak.setJSON('meta', { at });
        backedUp = true;
      }
      return json({ ok: true, published: Object.keys(want).length, backedUp, notified, status: await statusOf(Object.keys(want)) });
    }

    if (path === 'backup' && req.method === 'GET') {
      if (!(await isAdmin())) { await sleep(1200); return json({ error: 'wrongpassword' }, 401); }
      const d = await bak.get('latest', { type: 'json' });
      return d ? json(d) : json({ error: 'notfound' }, 404);
    }

    if (path === 'status' && req.method === 'GET') {
      if (!(await isAdmin())) { await sleep(1200); return json({ error: 'wrongpassword' }, 401); }
      const { blobs } = await sch.list();
      return json({ ok: true, status: await statusOf(blobs.map((b) => b.key)) });
    }

    if (path === 'push-key' && req.method === 'GET') return json({ key: (await vapid()).publicKey });

    if (path === 'subscribe' && req.method === 'POST') {
      const body = JSON.parse((await req.text()).slice(0, 5000));
      const k = phoneKey(body.phone), sub = body.sub;
      if (k.length < 7 || !sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return json({ error: 'bad' }, 400);
      if (!(await sch.get(k, { type: 'json' }))) return json({ error: 'notfound' }, 404);
      const a = await staffAuth(k); if (a !== 'ok') return denied(a);
      const list = ((await subs.get(k, { type: 'json' })) || []).filter((x) => x.endpoint !== sub.endpoint);
      list.push({ endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } });
      await subs.setJSON(k, list.slice(-5));
      return json({ ok: true });
    }

    if (path === 'seen' && req.method === 'POST') {
      const body = JSON.parse((await req.text()).slice(0, 500));
      const k = phoneKey(body.phone);
      const d = k.length >= 7 ? await sch.get(k, { type: 'json' }) : null;
      if (!d) return json({ error: 'notfound' }, 404);
      const a = await staffAuth(k); if (a !== 'ok') return denied(a);
      if (body.upd && body.upd === d.upd) await seen.setJSON(k, { at: new Date().toISOString(), upd: d.upd });
      return json({ ok: true });
    }

    return json({ error: 'unknown' }, 404);
  } catch (e) {
    return json({ error: 'server' }, 500);
  }
};

export const config = { path: '/api/*' };

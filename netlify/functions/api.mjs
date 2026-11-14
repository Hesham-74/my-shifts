// Small server for the staff apps.
//   GET  /api/schedule?phone=...   anyone: one employee's days and times (never pay)
//   POST /api/login                manager: first call sets the password, later calls check it
//   PUT  /api/sync                 manager: replace all schedules + save a full private backup
//   GET  /api/backup               manager: read the latest backup
import { getStore } from '@netlify/blobs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

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
  return { name: String((s && s.name) || '').slice(0, 80), shifts, off, upd: new Date().toISOString() };
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\//, '').replace(/\/+$/, '');
  const cfg = getStore({ name: 'config', consistency: 'strong' });
  const sch = getStore({ name: 'schedules', consistency: 'strong' });
  const bak = getStore({ name: 'backup', consistency: 'strong' });

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
      return d ? json(d) : json({ error: 'notfound' }, 404);
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
      for (const b of blobs) if (!want[b.key]) await sch.delete(b.key);
      for (const k of Object.keys(want)) await sch.setJSON(k, want[k]);
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
      return json({ ok: true, published: Object.keys(want).length, backedUp });
    }

    if (path === 'backup' && req.method === 'GET') {
      if (!(await isAdmin())) { await sleep(1200); return json({ error: 'wrongpassword' }, 401); }
      const d = await bak.get('latest', { type: 'json' });
      return d ? json(d) : json({ error: 'notfound' }, 404);
    }

    return json({ error: 'unknown' }, 404);
  } catch (e) {
    return json({ error: 'server' }, 500);
  }
};

export const config = { path: '/api/*' };

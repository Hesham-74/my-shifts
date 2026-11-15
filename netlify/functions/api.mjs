// Server for the staff apps. Every business has its own account and its own records.
//   Accounts:   POST /api/auth/signup | auth/login | auth/logout | auth/forgot | auth/reset | auth/password
//               GET /api/team, POST /api/team/add | team/remove | team/password   (the owner manages supervisors)
//   Employees:  POST /api/enter, /api/setpin, /api/subscribe, /api/seen, /api/ask
//               GET /api/schedule, /api/payslips              (phone + their own code, plus the business id "c")
//   Managers:   PUT /api/sync, GET /api/data | backup | status, POST /api/nudge | admin-remind | resetpin
import { createHash, randomBytes, randomInt, timingSafeEqual, scrypt as scryptCb } from 'node:crypto';
import webpush from 'web-push';
import { storesFor, globalStore, phoneKey } from '../lib/tenant.mjs';
import { payslipPdf, payslipFileName } from '../lib/payslip-pdf.mjs';

const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
const sha = (x) => createHash('sha256').update(String(x)).digest('hex');
const scrypt = (pw, salt) => new Promise((res, rej) => scryptCb(String(pw), salt, 32, (e, k) => (e ? rej(e) : res(k.toString('hex')))));
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CID = /^(legacy|c[a-f0-9]{12})$/;
const DAY = 86400000;
// Roles, highest first. "admin" is the name accounts had before managers existed: it means owner.
const ROLES = ['owner', 'manager', 'supervisor'];
const roleName = (r) => (r === 'admin' ? 'owner' : ROLES.indexOf(r) > -1 ? r : 'supervisor');
const rank = (r) => ({ owner: 3, manager: 2, supervisor: 1 })[roleName(r)] || 0;
const FROM_DOMAIN = process.env.MAIL_FROM_DOMAIN || 'mail.myshifts.info';
async function sendMail(to, subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'My Shifts <account@' + FROM_DOMAIN + '>', to: [to], subject, html }) });
    return r.ok;
  } catch (e) { return false; }
}
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
  return { name: String((s && s.name) || '').slice(0, 80), shifts, off, leave: !!(s && s.leave) };
}
// The part of a schedule an employee should be told about: today and later.
const futureSig = (s, today) => JSON.stringify([s.shifts.filter((x) => x.d >= today), s.off.filter((d) => d >= today)]);
const fullSig = (s) => JSON.stringify([s.name, s.shifts, s.off, !!s.leave]);
// What a supervisor's phone receives: everything except money (rates, bank, cash).
const noMoney = (st) => {
  const staff = {}, weeks = {};
  Object.keys(st.staff || {}).forEach((id) => { const { rate, bank, pay, ...rest } = st.staff[id]; staff[id] = rest; });
  Object.keys(st.weeks || {}).forEach((wid) => {
    const w = st.weeks[wid], snap = {};
    Object.keys(w.snap || {}).forEach((sid) => { const { rate, bank, ...rest } = w.snap[sid]; snap[sid] = rest; });
    weeks[wid] = { ...w, snap, cash: {}, slips: {} };
  });
  return { staff, weeks, branches: st.branches || {}, settings: {} };
};

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\//, '').replace(/\/+$/, '');
  const G = { cfg: globalStore('config'), accounts: globalStore('accounts'), sessions: globalStore('sessions'), companies: globalStore('companies'), phones: globalStore('phones') };
  // The business this request is about; set once the caller is known.
  let cid = null, cfg, sch, bak, subs, seen, pins, asks, slips;
  const use = (c) => { cid = c; const S = storesFor(c); cfg = S.config; sch = S.schedules; bak = S.backup; subs = S.subs; seen = S.seen; pins = S.pins; asks = S.asks; slips = S.payslips; };
  const body_ = async (max) => { try { return JSON.parse((await req.text()).slice(0, max || 2000)) || {}; } catch (e) { return {}; } };

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
    let v = await G.cfg.get('vapid', { type: 'json' });
    if (!v) { v = webpush.generateVAPIDKeys(); await G.cfg.setJSON('vapid', v); }
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
      const ak = await asks.get(k, { type: 'json' });
      out[k] = { ask: ak ? ak.at : null, pin: !!(await pins.get(k, { type: 'json' })), chg: d.chg || null, seen: sn && sn.upd === d.upd ? sn.at : null, lastSeen: sn ? sn.at : null, push: sl.length > 0 };
    }
    return out;
  };

  const tokenOf = () => { const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.get('authorization') || ''); return m ? m[1] : ''; };
  const matches = (t, a) => { if (!t || !a) return false; const x = Buffer.from(hashOf(t, a.salt)), y = Buffer.from(a.hash); return x.length === y.length && timingSafeEqual(x, y); };
  // The signed-in manager or supervisor: { cid, role, uid }, or null.
  const sessionOf = async () => {
    const t = tokenOf(); if (!t) return null;
    const ss = await G.sessions.get(sha(t), { type: 'json' });
    if (ss && ss.exp > Date.now()) {
      const acc = await G.accounts.get('u:' + ss.uid, { type: 'json' });
      if (acc) return { cid: acc.cid, role: roleName(acc.role), uid: ss.uid, acc };
    }
    // The single business password used before accounts existed, until the owner moves it to an account.
    const L = storesFor('legacy').config;
    if (!(await L.get('claimed', { type: 'json' }))) {
      if (matches(t, await L.get('admin', { type: 'json' }))) return { cid: 'legacy', role: 'owner', uid: null, legacy: true };
      if (matches(t, await L.get('supervisor', { type: 'json' }))) return { cid: 'legacy', role: 'supervisor', uid: null, legacy: true };
    }
    return null;
  };
  let me = null;
  const signedIn = async (need) => {
    me = await sessionOf();
    if (!me || (need === 'admin' && rank(me.role) < 2)) { await sleep(800); return false; }
    use(me.cid); return true;
  };
  const roleOf = async () => (me ? me.role : null);
  const isAdmin = async () => !!me && rank(me.role) >= 2;
  const isUser = async () => !!me;
  const no = () => json({ error: 'wrongpassword' }, 401);

  // An employee's business: from the app ("c"), or found from their phone number.
  const companyFor = async (k, c) => {
    if (k.length < 7) return null;
    if (c) return CID.test(c) && (await storesFor(c).schedules.get(k, { type: 'json' })) ? c : null;
    const found = [];
    for (const x of ((await G.phones.get(k, { type: 'json' })) || [])) if (CID.test(x) && found.indexOf(x) < 0 && (await storesFor(x).schedules.get(k, { type: 'json' }))) found.push(x);
    if (found.indexOf('legacy') < 0 && (await storesFor('legacy').schedules.get(k, { type: 'json' }))) found.push('legacy');
    return found.length === 1 ? found[0] : found.length ? found : null;
  };
  const staffCtx = async (phone, c) => {
    const k = phoneKey(phone), co = await companyFor(k, c);
    if (!co) return { err: json({ error: 'notfound' }, 404) };
    if (Array.isArray(co)) return { err: json({ error: 'choose' }, 409) };
    use(co); return { k };
  };

  // Accounts
  const newSession = async (acc) => {
    const token = randomBytes(32).toString('hex'), key = sha(token);
    await G.sessions.setJSON(key, { uid: acc.uid, exp: Date.now() + 180 * DAY });
    const list = (acc.sessions || []).concat([key]);
    for (const old of list.slice(0, Math.max(0, list.length - 10))) await G.sessions.delete(old);
    acc.sessions = list.slice(-10);
    await G.accounts.setJSON('u:' + acc.uid, acc);
    return token;
  };
  const endSessions = async (acc) => { for (const k of acc.sessions || []) await G.sessions.delete(k); acc.sessions = []; };
  const accountFor = async (id) => {
    const v = String(id || '').trim().toLowerCase(), key = v.indexOf('@') > -1 ? 'e:' + v : 'p:' + phoneKey(v);
    if (key === 'p:' || key.length < 6) return null;
    const ref = await G.accounts.get(key, { type: 'json' });
    return ref ? G.accounts.get('u:' + ref.uid, { type: 'json' }) : null;
  };
  const freeIds = async (email, pk) => {
    if (email && (await G.accounts.get('e:' + email, { type: 'json' }))) return 'emailtaken';
    if (pk && (await G.accounts.get('p:' + pk, { type: 'json' }))) return 'phonetaken';
    return '';
  };
  const makeAccount = async (c, role, name, email, pk, password) => {
    const uid = 'u' + randomBytes(8).toString('hex'), salt = randomBytes(16).toString('hex');
    const acc = { uid, cid: c, role, name: String(name || '').slice(0, 80), email: email || '', phone: pk || '', salt, hash: await scrypt(password, salt), created: new Date().toISOString(), sessions: [] };
    await G.accounts.setJSON('u:' + uid, acc);
    if (email) await G.accounts.setJSON('e:' + email, { uid });
    if (pk) await G.accounts.setJSON('p:' + pk, { uid });
    return acc;
  };
  const dropAccount = async (acc) => {
    await endSessions(acc);
    if (acc.email) await G.accounts.delete('e:' + acc.email);
    if (acc.phone) await G.accounts.delete('p:' + acc.phone);
    await G.accounts.delete('u:' + acc.uid);
  };
  const welcome = async (acc, token) => {
    const co = (await G.companies.get(acc.cid, { type: 'json' })) || {};
    use(acc.cid);
    const meta = await bak.get('meta', { type: 'json' });
    return json({ ok: true, token, role: roleName(acc.role), cid: acc.cid, company: co.name || '', name: acc.name, email: acc.email, hasBackup: !!meta });
  };
  const pwOK = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 200;

  const sharedState = async () => {
    const meta = (await bak.get('meta', { type: 'json' })) || {};
    const doc = await bak.get('latest', { type: 'json' });
    return { rev: meta.rev || 0, staff: doc ? doc.staff : {}, weeks: doc ? doc.weeks : {}, branches: doc && doc.branches ? doc.branches : {}, settings: doc && doc.settings ? doc.settings : {}, has: !!doc };
  };

  try {
    if (path === 'schedule' && req.method === 'GET') {
      const sc = await staffCtx(url.searchParams.get('phone'), url.searchParams.get('c')); if (sc.err) return sc.err; const k = sc.k;
      const d = await sch.get(k, { type: 'json' });
      const a = await staffAuth(k); if (a !== 'ok') return denied(a);
      return json(d);
    }

    if (path === 'enter' && req.method === 'POST') {
      const b = await body_(300), k = phoneKey(b.phone), co = await companyFor(k, b.c);
      if (!co) return json({ error: 'notfound' }, 404);
      if (Array.isArray(co)) {
        const list = [];
        for (const x of co) { const r = await G.companies.get(x, { type: 'json' }); list.push({ c: x, name: (r && r.name) || 'Your employer' }); }
        return json({ ok: true, choose: list });
      }
      use(co);
      const r = await G.companies.get(co, { type: 'json' });
      return json({ ok: true, c: co, company: (r && r.name) || '', hasPin: !!(await pins.get(k, { type: 'json' })) });
    }

    if (path === 'setpin' && req.method === 'POST') {
      const b = await body_(300), t = tokenOf();
      if (!t) return json({ error: 'bad' }, 400);
      const sc = await staffCtx(b.phone, b.c); if (sc.err) return sc.err; const k = sc.k;
      if (await pins.get(k, { type: 'json' })) return json({ error: 'haspin' }, 409);
      const salt = randomBytes(16).toString('hex');
      await pins.setJSON(k, { salt, hash: hashOf(t, salt), fails: 0 });
      return json({ ok: true });
    }

    if (path === 'nudge' && req.method === 'POST') {
      if (!(await signedIn())) return no();
      const body = await body_(300);
      let keys;
      if (body.phone) keys = [phoneKey(body.phone)]; else keys = (await sch.list()).blobs.map((b) => b.key);
      let sent = 0, off = 0;
      for (const k of keys) { const n = await notify(k, 'Your manager asks you to check your work times.'); if (n) sent++; else off++; }
      return json({ ok: true, sent, off });
    }

    if (path === 'admin-remind' && req.method === 'POST') {
      if (!(await signedIn())) return no();
      const body = await body_(5000);
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
      if (!(await signedIn('admin'))) return no();
      const body = await body_(300);
      const k = phoneKey(body.phone);
      await pins.delete(k); await subs.delete(k);
      return json({ ok: true, status: await statusOf([k]) });
    }

    if (path === 'login' && req.method === 'POST') {
      // The old single-business password. Works until the owner moves to an email account.
      if (!(await signedIn()) || !me.legacy) return no();
      const meta = await bak.get('meta', { type: 'json' });
      return json({ ok: true, created: false, legacy: true, role: me.role, hasBackup: !!meta, backupAt: meta ? meta.at : null, hasSupervisor: false });
    }

    if (path === 'auth/signup' && req.method === 'POST') {
      const b = await body_(1000);
      const company = String(b.company || '').trim().slice(0, 80), name = String(b.name || '').trim().slice(0, 80);
      const email = String(b.email || '').trim().toLowerCase(), pk = b.phone ? phoneKey(b.phone) : '';
      if (!company) return json({ error: 'company' }, 400);
      if (!EMAIL.test(email)) return json({ error: 'email' }, 400);
      if (pk && pk.length < 7) return json({ error: 'phone' }, 400);
      if (!pwOK(b.password)) return json({ error: 'password' }, 400);
      const taken = await freeIds(email, pk); if (taken) return json({ error: taken }, 409);
      let c = 'c' + randomBytes(6).toString('hex'), moved = false;
      // The first business moves its records to this account when the phone still holds its old password.
      if (/^[a-f0-9]{64}$/.test(String(b.legacy || ''))) {
        const L = storesFor('legacy').config;
        if (!(await L.get('claimed', { type: 'json' })) && matches(b.legacy, await L.get('admin', { type: 'json' }))) {
          c = 'legacy'; moved = true;
          await L.setJSON('claimed', { at: new Date().toISOString(), email });
          await L.delete('supervisor');
        }
      }
      const acc = await makeAccount(c, 'owner', name, email, pk, b.password);
      await G.companies.setJSON(c, { name: company, owner: acc.uid, members: [acc.uid], created: new Date().toISOString(), plan: 'trial' });
      const token = await newSession(acc);
      const res = await welcome(acc, token); const out = await res.json(); out.moved = moved;
      return json(out);
    }

    if (path === 'auth/login' && req.method === 'POST') {
      const b = await body_(500), acc = await accountFor(b.id);
      if (!acc) { await sleep(800); return json({ error: 'wrong' }, 401); }
      if (acc.lockUntil && Date.now() < acc.lockUntil) return json({ error: 'locked' }, 429);
      if ((await scrypt(b.password || '', acc.salt)) !== acc.hash) {
        acc.fails = (acc.fails || 0) + 1;
        if (acc.fails >= 5) { acc.fails = 0; acc.lockUntil = Date.now() + 15 * 60000; }
        await G.accounts.setJSON('u:' + acc.uid, acc); await sleep(800);
        return json({ error: 'wrong' }, 401);
      }
      acc.fails = 0; acc.lockUntil = 0;
      return welcome(acc, await newSession(acc));
    }

    if (path === 'auth/logout' && req.method === 'POST') {
      const t = tokenOf(); if (t) await G.sessions.delete(sha(t));
      return json({ ok: true });
    }

    if (path === 'auth/forgot' && req.method === 'POST') {
      const b = await body_(300), email = String(b.email || '').trim().toLowerCase();
      const acc = EMAIL.test(email) ? await accountFor(email) : null;
      if (acc) {
        const code = String(randomInt(0, 1000000)).padStart(6, '0'), salt = randomBytes(8).toString('hex');
        await G.accounts.setJSON('r:' + email, { salt, hash: sha(salt + code), exp: Date.now() + 30 * 60000, tries: 0 });
        await sendMail(email, 'Your My Shifts code: ' + code, '<div style="font:16px Arial,Helvetica,sans-serif;color:#14213a;max-width:480px;margin:0 auto;padding:16px"><p>Your code to set a new password:</p><p style="font:bold 30px monospace;letter-spacing:6px">' + code + '</p><p style="color:#566580">It works for 30 minutes. If you did not ask for it, you can ignore this email.</p></div>');
      }
      return json({ ok: true });
    }

    if (path === 'auth/reset' && req.method === 'POST') {
      const b = await body_(500), email = String(b.email || '').trim().toLowerCase();
      const r = await G.accounts.get('r:' + email, { type: 'json' }), acc = r ? await accountFor(email) : null;
      if (!r || !acc || r.exp < Date.now() || r.tries >= 5) { await sleep(800); return json({ error: 'code' }, 400); }
      if (sha(r.salt + String(b.code || '').trim()) !== r.hash) { r.tries++; await G.accounts.setJSON('r:' + email, r); await sleep(800); return json({ error: 'code' }, 400); }
      if (!pwOK(b.password)) return json({ error: 'password' }, 400);
      await G.accounts.delete('r:' + email);
      await endSessions(acc);
      acc.salt = randomBytes(16).toString('hex'); acc.hash = await scrypt(b.password, acc.salt); acc.fails = 0; acc.lockUntil = 0;
      return welcome(acc, await newSession(acc));
    }

    if (path === 'auth/password' && req.method === 'POST') {
      if (!(await signedIn()) || !me.acc) return no();
      const b = await body_(500), acc = me.acc;
      if ((await scrypt(b.old || '', acc.salt)) !== acc.hash) { await sleep(800); return json({ error: 'wrong' }, 401); }
      if (!pwOK(b.password)) return json({ error: 'password' }, 400);
      acc.salt = randomBytes(16).toString('hex'); acc.hash = await scrypt(b.password, acc.salt);
      await endSessions(acc);
      return json({ ok: true, token: await newSession(acc) });
    }

    if (path === 'auth/delete' && req.method === 'POST') {
      // Delete my account. An owner's deletion removes the whole business and everything in it.
      if (!(await signedIn()) || !me.acc) return no();
      const b = await body_(500), acc = me.acc;
      if ((await scrypt(b.password || '', acc.salt)) !== acc.hash) { await sleep(800); return json({ error: 'wrong' }, 401); }
      const co = (await G.companies.get(cid, { type: 'json' })) || { members: [] };
      if (roleName(acc.role) !== 'owner' || co.owner !== acc.uid) {
        await dropAccount(acc);
        co.members = (co.members || []).filter((u) => u !== acc.uid); await G.companies.setJSON(cid, co);
        return json({ ok: true, deleted: 'account' });
      }
      for (const u of co.members || []) { const a = await G.accounts.get('u:' + u, { type: 'json' }); if (a) await dropAccount(a); }
      const S = storesFor(cid);
      for (const name of Object.keys(S)) {
        const { blobs } = await S[name].list();
        for (const x of blobs) {
          if (name === 'schedules') { const ix = ((await G.phones.get(x.key, { type: 'json' })) || []).filter((c) => c !== cid); if (ix.length) await G.phones.setJSON(x.key, ix); else await G.phones.delete(x.key); }
          if (cid === 'legacy' && name === 'config' && x.key === 'vapid') continue;   // shared notification key, not business data
          await S[name].delete(x.key);
        }
      }
      if (cid === 'legacy') await storesFor('legacy').config.setJSON('claimed', { at: new Date().toISOString(), deleted: true });
      await G.companies.delete(cid);
      return json({ ok: true, deleted: 'business' });
    }

    if (path === 'forget-me' && req.method === 'POST') {
      // An employee removes their login, notifications and read receipts. Their hours stay with their employer.
      const b = await body_(300);
      const sc = await staffCtx(b.phone, b.c); if (sc.err) return sc.err; const k = sc.k;
      const a = await staffAuth(k); if (a !== 'ok') return denied(a);
      await pins.delete(k); await subs.delete(k); await seen.delete(k); await asks.delete(k);
      return json({ ok: true });
    }

    if (path.indexOf('team') === 0) {
      // Owners manage everyone. Managers add and remove supervisors. The person who created the business cannot be removed or demoted.
      if (!(await signedIn('admin')) || !me.acc) return no();
      const co = (await G.companies.get(cid, { type: 'json' })) || { members: [] };
      const myRank = rank(me.role);
      const members = async () => {
        const out = [];
        for (const u of co.members || []) { const a = await G.accounts.get('u:' + u, { type: 'json' }); if (a) out.push({ uid: a.uid, name: a.name, email: a.email, phone: a.phone, role: roleName(a.role), founder: u === co.owner, owner: u === co.owner, me: u === me.uid }); }
        out.sort((x, y) => rank(y.role) - rank(x.role) || String(x.name).localeCompare(String(y.name)));
        return out;
      };
      if (path === 'team' && req.method === 'GET') return json({ ok: true, company: co.name, myRole: me.role, members: await members() });
      const b = await body_(1000);
      const wantRole = ROLES.indexOf(b.role) > -1 ? b.role : 'supervisor';
      if (path === 'team/add' && req.method === 'POST') {
        if (rank(wantRole) >= 2 && myRank < 3) return json({ error: 'notallowed' }, 403);
        const email = String(b.email || '').trim().toLowerCase(), pk = b.phone ? phoneKey(b.phone) : '';
        if (!email && !pk) return json({ error: 'id' }, 400);
        if (email && !EMAIL.test(email)) return json({ error: 'email' }, 400);
        if (pk && pk.length < 7) return json({ error: 'phone' }, 400);
        if (!pwOK(b.password)) return json({ error: 'password' }, 400);
        const taken = await freeIds(email, pk); if (taken) return json({ error: taken }, 409);
        const acc = await makeAccount(cid, wantRole, b.name, email, pk, b.password);
        co.members = (co.members || []).concat([acc.uid]); await G.companies.setJSON(cid, co);
        return json({ ok: true, members: await members() });
      }
      const target = (co.members || []).indexOf(String(b.uid || '')) > -1 ? await G.accounts.get('u:' + b.uid, { type: 'json' }) : null;
      if (!target || target.uid === co.owner || target.uid === me.uid) return json({ error: 'member' }, 400);
      // A manager can only act on supervisors; an owner on anyone else.
      if (myRank < 3 && rank(target.role) >= 2) return json({ error: 'notallowed' }, 403);
      if (path === 'team/role' && req.method === 'POST') {
        if (myRank < 3) return json({ error: 'notallowed' }, 403);
        if (roleName(target.role) !== wantRole) {
          target.role = wantRole; await G.accounts.setJSON('u:' + target.uid, target);
        }
        return json({ ok: true, members: await members() });
      }
      if (path === 'team/remove' && req.method === 'POST') {
        await dropAccount(target);
        co.members = co.members.filter((u) => u !== target.uid); await G.companies.setJSON(cid, co);
        return json({ ok: true, members: await members() });
      }
      if (path === 'team/password' && req.method === 'POST') {
        if (!pwOK(b.password)) return json({ error: 'password' }, 400);
        target.salt = randomBytes(16).toString('hex'); target.hash = await scrypt(b.password, target.salt);
        await endSessions(target); await G.accounts.setJSON('u:' + target.uid, target);
        return json({ ok: true });
      }
      return json({ error: 'unknown' }, 404);
    }

    if (path === 'sync' && req.method === 'PUT') {
      if (!(await signedIn())) return no();
      const role = me.role;
      const text = await req.text();
      if (text.length > 3000000) return json({ error: 'toolarge' }, 413);
      const body = JSON.parse(text);
      // Someone else saved since this phone last looked: hand back the newest records so it can merge and resend.
      const cur = await sharedState();
      if (cur.has && cur.rev > 0 && body.baseRev !== cur.rev) return json({ error: 'stale', rev: cur.rev, ...(role === 'supervisor' ? noMoney(cur) : { staff: cur.staff, weeks: cur.weeks, branches: cur.branches, settings: cur.settings }) }, 409);
      if (role === 'supervisor' && !cur.has) return json({ error: 'nodata' }, 409);
      const want = {};
      Object.keys(body.schedules || {}).slice(0, 300).forEach((p) => { const k = phoneKey(p); if (k.length >= 7 && !want[k]) want[k] = cleanSchedule(body.schedules[p]); });
      const { blobs } = await sch.list();
      for (const b of blobs) if (!want[b.key]) {
        await sch.delete(b.key); await subs.delete(b.key); await seen.delete(b.key); await pins.delete(b.key); await asks.delete(b.key);
        const ix = ((await G.phones.get(b.key, { type: 'json' })) || []).filter((x) => x !== cid);
        if (ix.length) await G.phones.setJSON(b.key, ix); else await G.phones.delete(b.key);
      }
      const had = {}; blobs.forEach((b) => { had[b.key] = 1; });
      for (const k of Object.keys(want)) {
        const ix = (await G.phones.get(k, { type: 'json' })) || [];
        if (ix.indexOf(cid) < 0) await G.phones.setJSON(k, ix.concat([cid]));
      }
      const now = new Date().toISOString();
      const today = DATE.test(body.today) ? body.today : now.slice(0, 10);
      let notified = 0; const pend = {};
      for (const k of Object.keys(want)) {
        const prev = await sch.get(k, { type: 'json' });
        const next = want[k];
        if (prev && fullSig(prev) === fullSig(next)) continue;            // nothing changed for this person
        next.upd = now;
        next.chg = prev ? prev.chg || null : null;
        const changedAhead = prev ? futureSig(prev, today) !== futureSig(next, today) : (next.shifts.some((x) => x.d >= today) || next.off.some((d) => d >= today));
        if (changedAhead) { next.chg = now; }
        await sch.setJSON(k, next);
        await asks.delete(k);
        if (changedAhead && prev) pend[k] = 1;   // told later: when the manager taps Send, or 30 minutes after the last change
      }
      let backedUp = false;
      const bk = body.backup;
      let rev = cur.rev;
      if (bk && bk.staff && bk.weeks && typeof bk.staff === 'object' && typeof bk.weeks === 'object' && (Object.keys(bk.staff).length || Object.keys(bk.weeks).length)) {
        let staff = bk.staff, weeks = bk.weeks, branches = bk.branches && typeof bk.branches === 'object' ? bk.branches : cur.branches, settings = bk.settings && typeof bk.settings === 'object' ? bk.settings : cur.settings;
        if (role === 'supervisor') {
          // A supervisor records hours and days off. Staff, rates, bank, cash and week settings stay as the manager left them.
          staff = cur.staff; weeks = {}; branches = cur.branches; settings = cur.settings;
          const ids = Object.keys(cur.weeks).sort(), lastCfg = ids.length ? cur.weeks[ids[ids.length - 1]].cfg : null;
          Object.keys(cur.weeks).forEach((wid) => { weeks[wid] = cur.weeks[wid]; });
          Object.keys(bk.weeks).forEach((wid) => {
            if (!DATE.test(wid)) return;
            const nw = bk.weeks[wid] || {}, cw = cur.weeks[wid];
            const snap = {};
            Object.keys(nw.snap || {}).forEach((sid) => {
              if (cw && cw.snap && cw.snap[sid]) snap[sid] = cw.snap[sid];
              else if (staff[sid]) snap[sid] = { name: staff[sid].name, position: staff[sid].position || '', rate: Number(staff[sid].rate) || 0, bank: Number(staff[sid].bank) || 0 };
            });
            if (cw && cw.snap) Object.keys(cw.snap).forEach((sid) => { if (!snap[sid]) snap[sid] = cw.snap[sid]; });
            weeks[wid] = { cfg: cw ? cw.cfg : (lastCfg || nw.cfg || { lunch: 0, otAfter: 40, otPremium: 0 }), snap, shifts: Array.isArray(nw.shifts) ? nw.shifts : [], cash: cw ? cw.cash || {} : {}, off: nw.off && typeof nw.off === 'object' ? nw.off : {}, slips: cw ? cw.slips || {} : {} };
          });
        }
        const at = new Date().toISOString();
        const doc = { app: 'weekly-staff-pay', version: 1, exportedAt: at, staff, weeks, branches, settings };
        rev = cur.rev + 1;
        await bak.setJSON('latest', doc);
        await bak.setJSON('day-' + at.slice(0, 10), doc);
        await bak.setJSON('meta', { at, rev, by: role });
        backedUp = true;
      }
      const pq = (await cfg.get('pending', { type: 'json' })) || { keys: {} };
      Object.keys(pq.keys || {}).forEach((k) => { if (!want[k]) delete pq.keys[k]; });
      if (Object.keys(pend).length) { pq.keys = Object.assign(pq.keys || {}, pend); pq.last = Date.now(); }
      await cfg.setJSON('pending', pq);
      return json({ ok: true, rev, published: Object.keys(want).length, backedUp, notified, pending: Object.keys(pq.keys || {}).length, pendingSince: pq.last || null, status: await statusOf(Object.keys(want)) });
    }

    if (path === 'data' && req.method === 'GET') {
      if (!(await signedIn())) return no();
      const role = me.role;
      const cur = await sharedState();
      if (String(cur.rev) === url.searchParams.get('rev')) return json({ ok: true, same: true, rev: cur.rev, role });
      const coRec = (await G.companies.get(cid, { type: 'json' })) || {};
      return json({ ok: true, rev: cur.rev, role, company: coRec.name || '', has: cur.has, ...(role === 'supervisor' ? noMoney(cur) : { staff: cur.staff, weeks: cur.weeks, branches: cur.branches, settings: cur.settings }) });
    }

    if (path === 'backup' && req.method === 'GET') {
      if (!(await signedIn('admin'))) return no();
      const d = await bak.get('latest', { type: 'json' });
      return d ? json(d) : json({ error: 'notfound' }, 404);
    }

    if (path === 'notify-now' && req.method === 'POST') {
      // Tell everyone whose coming shifts changed since the last time staff were told.
      if (!(await signedIn())) return no();
      const pq = (await cfg.get('pending', { type: 'json' })) || { keys: {} };
      let sent = 0, people = 0;
      for (const k of Object.keys(pq.keys || {})) { people++; try { if (await notify(k)) sent++; } catch (e) { /* next person */ } }
      await cfg.setJSON('pending', { keys: {}, last: null, sentAt: Date.now() });
      return json({ ok: true, people, sent });
    }

    if (path === 'status' && req.method === 'GET') {
      if (!(await signedIn())) return no();
      const { blobs } = await sch.list();
      const pq = (await cfg.get('pending', { type: 'json' })) || { keys: {} };
      return json({ ok: true, pending: Object.keys(pq.keys || {}).length, pendingSince: pq.last || null, status: await statusOf(blobs.map((b) => b.key)) });
    }

    if (path === 'push-key' && req.method === 'GET') return json({ key: (await vapid()).publicKey });

    if (path === 'subscribe' && req.method === 'POST') {
      const body = await body_(5000), sub = body.sub;
      if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return json({ error: 'bad' }, 400);
      const sc = await staffCtx(body.phone, body.c); if (sc.err) return sc.err; const k = sc.k;
      const a = await staffAuth(k); if (a !== 'ok') return denied(a);
      const list = ((await subs.get(k, { type: 'json' })) || []).filter((x) => x.endpoint !== sub.endpoint);
      list.push({ endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } });
      await subs.setJSON(k, list.slice(-5));
      return json({ ok: true });
    }

    if (path === 'payslips' && req.method === 'GET') {
      const sc = await staffCtx(url.searchParams.get('phone'), url.searchParams.get('c')); if (sc.err) return sc.err; const k = sc.k;
      const a = await staffAuth(k); if (a !== 'ok') return denied(a);
      return json({ ok: true, list: (await slips.get(k, { type: 'json' })) || [] });
    }

    if (path === 'payslip-pdf' && req.method === 'GET') {
      // A payslip as a PDF: the owner or a manager for anyone, an employee for their own released payslips.
      const wid = String(url.searchParams.get('wid') || '');
      if (!DATE.test(wid)) return json({ error: 'bad' }, 400);
      let sl = null;
      if (url.searchParams.get('phone')) {
        const sc = await staffCtx(url.searchParams.get('phone'), url.searchParams.get('c')); if (sc.err) return sc.err;
        const a = await staffAuth(sc.k); if (a !== 'ok') return denied(a);
        const hit = ((await slips.get(sc.k, { type: 'json' })) || []).find((x) => x.wid === wid);
        sl = hit ? hit.slip : null;
      } else {
        if (!(await signedIn('admin'))) return no();
        const doc = await bak.get('latest', { type: 'json' }), sid = String(url.searchParams.get('sid') || '');
        const raw = doc && doc.weeks && doc.weeks[wid] && doc.weeks[wid].slips ? doc.weeks[wid].slips[sid] : null, st = doc && doc.staff ? doc.staff[sid] : null;
        const main = ((doc && doc.settings) || {}).main || {};
        if (raw && st) sl = { ...raw, fullName: (st.pay && st.pay.fullName) || st.name, pps: (st.pay && st.pay.pps) || '', company: main.company || '' };
      }
      if (!sl) return json({ error: 'notfound' }, 404);
      const pdf = await payslipPdf(sl, wid, { fullPps: true });
      return new Response(pdf, { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="' + payslipFileName(sl, wid) + '"', 'cache-control': 'no-store' } });
    }

    if (path === 'ask' && req.method === 'POST') {
      // An employee says their hours are missing: tell the manager's phone(s).
      const body = await body_(300);
      const sc = await staffCtx(body.phone, body.c); if (sc.err) return sc.err; const k = sc.k;
      const d = await sch.get(k, { type: 'json' });
      const a = await staffAuth(k); if (a !== 'ok') return denied(a);
      const prev = await asks.get(k, { type: 'json' });
      if (prev && Date.now() - Date.parse(prev.at) < 3 * 3600000) return json({ ok: true, already: true });
      await asks.setJSON(k, { at: new Date().toISOString() });
      const r = await cfg.get('remind', { type: 'json' });
      let sent = 0;
      if (r && r.subs && r.subs.length) {
        const v = await vapid();
        for (const sub of r.subs) {
          try { await webpush.sendNotification(sub, JSON.stringify({ title: 'Weekly Staff Pay', body: (d.name || 'An employee') + ' says their hours are missing.', tag: 'ask-' + k }), { TTL: 86400, urgency: 'high', vapidDetails: { subject: url.origin, publicKey: v.publicKey, privateKey: v.privateKey } }); sent++; } catch (e) { /* shown in the manager app either way */ }
        }
      }
      return json({ ok: true, sent });
    }

    if (path === 'seen' && req.method === 'POST') {
      const body = await body_(500);
      const sc = await staffCtx(body.phone, body.c); if (sc.err) return sc.err; const k = sc.k;
      const d = await sch.get(k, { type: 'json' });
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

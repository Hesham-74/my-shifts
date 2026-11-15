// Every business (company) keeps its records apart from every other one.
// Keys are stored as "<company id>/<key>". The first business, set up before accounts existed,
// is the company "legacy" and keeps its original keys without a prefix.
import { getStore } from '@netlify/blobs';

const NAMES = ['config', 'schedules', 'backup', 'subs', 'seen', 'pins', 'asks', 'payslips'];
const prefixOf = (cid) => (cid === 'legacy' ? '' : cid + '/');

function scoped(store, cid) {
  const p = prefixOf(cid);
  return {
    get: (k, o) => store.get(p + k, o),
    setJSON: (k, v) => store.setJSON(p + k, v),
    delete: (k) => store.delete(p + k),
    async list() {
      const { blobs } = p ? await store.list({ prefix: p }) : await store.list();
      return { blobs: blobs.filter((b) => (p ? b.key.startsWith(p) : b.key.indexOf('/') < 0)).map((b) => ({ ...b, key: b.key.slice(p.length) })) };
    }
  };
}

export function storesFor(cid) {
  const out = {};
  NAMES.forEach((n) => { out[n] = scoped(getStore({ name: n, consistency: 'strong' }), cid); });
  return out;
}
export const globalStore = (name) => getStore({ name, consistency: 'strong' });

// Companies the hourly job should look at.
export async function allCompanies() {
  const { blobs } = await globalStore('companies').list();
  const ids = blobs.map((b) => b.key);
  if (ids.indexOf('legacy') < 0) ids.push('legacy');
  return ids;
}

export const phoneKey = (p) => { const d = String(p == null ? '' : p).replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : d; };

// Phone-authoritative desktop changes. Plain records in, one guarded atomic write out.
import { typedShift } from './io.js';
import { validIso, owing, isFx } from './engine.js';
export { sdpFingerprint, sasCode, sasCommit, sasHandshake } from './desk-pair.js';
export const deskAccount = a => !!a && !owing(a) && !isFx(a) && (!a.scope || a.scope === 'me' || a.scope === 'personal');
export const deskEditable = x => ['expense', 'income'].includes(x.type) && !x.items?.length && !x.receiptId && !x.split && !x.splitOf && !x.down && !x.repaidBy && !x.repaidTo && !x.billId && !x.refundOf && !x.refund && !x.spouse;
export const recordVersion = x => JSON.stringify(x, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export function deskWrite(state, request, today) {
  const fail = () => { throw Error('Invalid computer change'); };
  if (!request || !['save', 'delete'].includes(request.kind) || typeof request.id !== 'string' || !/^dt_[a-f0-9-]{36}$|^[\w-]{1,60}$/i.test(request.id)) fail();
  const old = state.tx.find(x => x.id === request.id);
  if ((old ? recordVersion(old) : null) !== request.base) throw Object.assign(Error('The entry changed on your phone. Refresh and try again.'), { code: 'STALE' });
  if (old && (!deskEditable(old) || !deskAccount(state.accounts.find(a => a.id === old.accountId) || { kind: 'iowe' }))) fail();
  if (!old && !request.id.startsWith('dt_')) fail();
  const clean = (s, max) => { if (typeof s !== 'string' || s.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s)) fail(); return s.trim(); };
  let row;
  if (request.kind === 'save') {
    const v = request.value;
    if (!v || !['expense', 'income'].includes(v.type) || !Number.isSafeInteger(v.amount) || v.amount <= 0 || v.amount > 100_000_000_00 || !validIso(v.date) || v.date > today || typeof v.accountId !== 'string') fail();
    const account = state.accounts.find(a => a.id === v.accountId);
    if (!account || !deskAccount(account)) fail();
    const cats = state.categories || [];
    if (!cats.some(c => c.id === v.category && c.type === v.type)) fail();
    row = { ...old, id: request.id, type: v.type, amount: v.amount, date: v.date, accountId: v.accountId, category: v.category, merchant: clean(v.merchant, 80), note: clean(v.note, 200), source: old?.source || 'quick', createdAt: old?.createdAt || Date.now() };
    if (old && (old.category !== v.category || old.type !== v.type)) delete row.sub;
  } else if (!old) throw Object.assign(Error('The entry changed on your phone. Refresh and try again.'), { code: 'STALE' });
  const remaining = state.tx.filter(x => x.id !== request.id), before = typedShift(state.accounts, remaining, old ? [old] : [], today), after = typedShift(state.accounts, remaining, row ? [row] : [], today);
  const accounts = state.accounts.filter(a => (after[a.id] || 0) !== (before[a.id] || 0)).map(a => ({ ...a, opening: (a.opening || 0) + (after[a.id] || 0) - (before[a.id] || 0), updatedAt: Date.now() }));
  const touched = new Set([old?.accountId, row?.accountId]);
  return { tx: row ? [row] : [], accounts, del: request.kind === 'delete' ? { tx: [request.id] } : {}, edit: true,
    expected: { tx: [{ id: request.id, value: old }], accounts: state.accounts.filter(a => touched.has(a.id)).map(a => ({ id: a.id, value: a })), kv: state.guardKv || [{ id: 'settings', value: { key: 'settings', value: state.settings } }] } };
}

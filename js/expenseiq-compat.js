import { readExpenseIQ } from './expenseiq.js';
import { cleanText, okMs } from './io.js';
/** Refuse source values a normal Tally backup would silently change. */
export function readCompatibleExpenseIQ(bytes, options) {
  let p;
  try { p = readExpenseIQ(bytes, options); }
  catch(e) {
    const message = /Only MYR/.test(e.message) ? 'ExpenseIQ foreign currencies are not supported. Choose a MYR-only backup. Nothing was imported.'
      : /Split, repeating|project\/debt/.test(e.message) ? 'ExpenseIQ split, repeating and project entries are not supported. Nothing was imported.'
      : /Unsupported table|column schema|version is unsupported/.test(e.message) ? 'This ExpenseIQ version or financial layout is not supported. Choose a V3 backup of ordinary MYR entries. Nothing was imported.'
      : 'This ExpenseIQ backup has invalid data or unsupported financial forms. Keep the original file and check the supported limits. Nothing was imported.';
    throw new Error(message,{cause:e});
  }
  const check = (value, max) => { if (cleanText(value, max) !== value) throw new Error('This ExpenseIQ backup contains text that Tally would change. Nothing was imported.'); };
  for (const a of p.accounts) { check(a.name, 40); if (okMs(a.createdAt) !== a.createdAt) throw new Error('This ExpenseIQ backup has creation timestamps outside the supported range. Nothing was imported.'); }
  for (const c of p.customCats) check(c.name, 40);
  for (const names of Object.values(p.subcats)) for (const name of names) check(name, 30);
  for (const t of p.tx) { check(t.merchant, 80); check(t.note, 200); if (okMs(t.createdAt) !== t.createdAt) throw new Error('This ExpenseIQ backup has creation timestamps outside the supported range. Nothing was imported.'); }
  return p;
}

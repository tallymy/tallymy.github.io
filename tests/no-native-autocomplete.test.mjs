// A native <datalist> popup takes the taps meant for typing and Android Back closes the whole sheet instead of the popup.
// Suggestions are in-page chips (money.js `suggest`). Keep it that way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const files = d => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? (f === 'i18n' ? [] : files(p)) : p.endsWith('.js') ? [p] : []; });

test('no native datalist or list= autocomplete in the app', () => {
  for (const f of files('js')) {
    const s = readFileSync(f, 'utf8');
    assert.ok(!/<datalist|\slist="/.test(s), `${f} uses a native datalist`);
  }
});

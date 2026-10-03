// Explicit public-asset allowlist. Never package receipts, notes, test data, or the service worker.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, lstatSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(process.argv[2] || resolve(project, '..'));
const target = resolve(project, 'www');
if (target !== join(project, 'www') || source === target || !existsSync(join(source, 'index.html'))) throw Error('Invalid web source or target');
const assets = ['index.html', 'connect.html', 'css', 'js', 'fonts', 'icons', 'img', 'models', 'vendor', 'manifest.webmanifest', 'build.txt', 'licences.html'];
assets.push(...readdirSync(source).filter(n => /^(privacy|terms)(\.[\w-]+)?\.html$/.test(n)));
const rejectLinks = p => { if (lstatSync(p).isSymbolicLink()) throw Error('Symlink in public assets: ' + p); if (lstatSync(p).isDirectory()) for (const n of readdirSync(p)) rejectLinks(join(p, n)); };
for (const asset of assets) { if (!existsSync(join(source, asset))) throw Error('Missing public asset: ' + asset); rejectLinks(join(source, asset)); }
mkdirSync(target, { recursive: true });
for (const n of readdirSync(target)) rmSync(join(target, n), { recursive: true, force: true });
for (const asset of assets) cpSync(join(source, asset), join(target, asset), { recursive: true });
console.log('Copied ' + assets.length + ' public asset roots into ' + target);

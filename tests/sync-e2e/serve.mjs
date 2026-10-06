// Desk-only HTTPS static server for the assembled tree (harness only, nothing here ships).
// Cache-Control: max-age=600 + Content-Length = the corrected header set from
// physical-native/qa/sw-bootstrap-diagnosis.md so the service worker's 120-file install does not stall.
import https from 'node:https';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const CERT = 'C:/Users/user/claude-sandbox/mm/.ocr-work/offline-sync-host/physical-native/';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.jpg': 'image/jpeg' };
export const sha = b => createHash('sha256').update(b).digest('hex');

// enableGates: harness-only override of the two literal-false source gates, applied to the served bytes (never to source).
export async function startServer({ root, enableGates = false, coop = true }) {
  const trace = [], missing = [];
  const server = https.createServer({ key: await readFile(CERT + 'fixture-local.key'), cert: await readFile(CERT + 'fixture-local.crt') }, async (req, res) => {
    const u = new URL(req.url, 'https://x');
    trace.push(u.pathname + u.search);
    try {
      const name = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname).slice(1);
      const file = path.resolve(root, name);
      if (!file.startsWith(path.resolve(root) + path.sep)) throw Error('outside');
      let body = await readFile(file);
      if (enableGates && name === 'js/book-sync/gates.mjs') body = Buffer.from(body.toString().replace('mainHostApproved=()=>false', 'mainHostApproved=()=>true').replace('localRecoveryApproved=()=>false', 'localRecoveryApproved=()=>true'));
      if (enableGates && name === 'js/book-sync/bootstrap.mjs') body = Buffer.from(body.toString()
        .replace('onOwnedCommit:owned,', 'onOwnedCommit:async e=>{try{return await owned(e);}catch(error){globalThis.__ownedCommitFailure={message:error.message,eventPlanId:e.planId};throw error;}},')
        .replace('if(!allowed()){await cleanup();return quiet;}adapter.install(runtime);ready=true;', 'globalThis.__ownedRuntime=runtime;if(!allowed()){await cleanup();return quiet;}adapter.install(runtime);ready=true;'));
      if (enableGates && name === 'js/book-sync/sync-controller.mjs') body = Buffer.from(body.toString().replace('catch(e){bothConfirmed=false;', 'catch(e){(globalThis.__ctrlErrs=globalThis.__ctrlErrs||[]).push(String(e.code)+":"+String(e.message).slice(0,200)+"|"+String(e.stack).slice(0,400));bothConfirmed=false;'));
      const headers = { 'Content-Type': TYPES[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'max-age=600', 'Content-Length': body.length };
      if (coop && !(enableGates === false && false)) headers['Cross-Origin-Opener-Policy'] = 'same-origin';
      if (process.env.COEP) headers['Cross-Origin-Embedder-Policy'] = 'credentialless';
      res.writeHead(200, headers); res.end(body);
    } catch { missing.push(u.pathname); res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, trace, missing, close: () => new Promise(r => server.close(r)) };
}
export const spki = async () => JSON.parse(await readFile(CERT + 'fixture-local-public.json')).spki;

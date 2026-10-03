import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
const source = await readFile(new URL('../js/native.js', import.meta.url), 'utf8');
const java = await readFile(process.env.TALLY_ANDROID_ROOT ? join(process.env.TALLY_ANDROID_ROOT, 'android/app/src/main/java/io/github/tallymy/TallyNativePlugin.java') : new URL('../android-wrapper/android/app/src/main/java/io/github/tallymy/TallyNativePlugin.java', import.meta.url), 'utf8');

function harness({ batches = [], fetcher, share = async () => {}, save = async () => ({ cancelled: false }), write = async () => {} } = {}) {
  const releases = [], deleted = [], errors = [], holds = [], outputReleases = [], reads = [], callbacks = new Map();
  const native = {
    takeShared: async () => batches.shift() || { files: [] }, releaseShared: async d => releases.push(d.uris),
    reserveOutput: async d => { const path = 'out/id' + holds.length + '-' + d.name; const uri = 'file:///cache/' + path; holds.push(uri); return { path, uri }; },
    releaseOutput: async d => outputReleases.push(d), saveToDevice: save,
    addListener: (n, f) => callbacks.set(n, f),
  };
  const context = vm.createContext({ Blob, File, URL, DOMException, crypto: webcrypto, btoa,
    location: { href: 'https://localhost/', origin: 'https://localhost' },
    Capacitor: { isNativePlatform: () => true, convertFileSrc: uri => 'https://localhost/_capacitor_file_/' + uri.split('/').pop(),
      Plugins: { TallyNative: native, Filesystem: { writeFile: write, appendFile: async () => {}, getUri: async ({ path }) => ({ uri: 'file:///cache/' + path }), deleteFile: async d => deleted.push(d.path) }, Share: { share }, App: { addListener() {} } } },
    navigator: {}, document: { addEventListener() {} }, window: { open() {} },
    fetch: async url => { reads.push(url); return fetcher ? fetcher(url) : { ok: true, blob: async () => new Blob(['abc']) }; },
    report: message => errors.push(message),
  });
  const code = source.replace(/\bexport /g, '').replace(/async function sharedError\(message\) \{[\s\S]*?\n\}/, 'async function sharedError(message) { report(message); }');
  vm.runInContext(code + '\nglobalThis.api = { sharedFiles, onShared, saveFile };', context);
  return { api: context.api, share: context.navigator.share, releases, deleted, errors, holds, outputReleases, reads, callbacks };
}
const f = (uri = 'file:///cache/shared/a', size = 3, type = 'application/json') => ({ uri, size, type, name: 'book.json' });

test('intake releases every leased URI on success and retains a bounded File', async () => {
  const h = harness({ batches: [{ files: [f()] }] });
  const files = await h.api.sharedFiles(); assert.equal(files[0].size, 3);
  assert.deepEqual(Array.from(h.releases[0]), [f().uri]);
});
test('preflight rejects oversized image before fetching and releases the entire batch', async () => {
  const files = [f('file:///cache/shared/a', 40 * 1024 * 1024 + 1, 'image/png'), f('file:///cache/shared/b')];
  const h = harness({ batches: [{ files }] }); assert.equal((await h.api.sharedFiles()).length, 0);
  assert.equal(h.reads.length, 0); assert.equal(h.releases[0].length, 2); assert.equal(h.errors.length, 1);
});
test('aggregate preflight rejects a 301 MiB intake before first fetch', async () => {
  const h = harness({ batches: [{ files: [f(undefined, 301 * 1024 * 1024)] }] });
  assert.equal((await h.api.sharedFiles()).length, 0); assert.equal(h.reads.length, 0); assert.equal(h.releases[0].length, 1);
});
test('failed fetch and lying byte metadata release intake without delivering partial data', async () => {
  for (const fetcher of [async () => { throw Error('network'); }, async () => ({ ok: true, blob: async () => new Blob(['too long']) })]) {
    const h = harness({ batches: [{ files: [f()] }], fetcher });
    assert.equal((await h.api.sharedFiles()).length, 0); assert.equal(h.releases[0].length, 1); assert.equal(h.errors.length, 1);
  }
});
test('save cleans immediately; selected share retains attachments; cancellation deletes', async () => {
  for (const reject of [false, true]) {
    const action = async () => { if (reject) throw Error('cancelled'); return { cancelled: false }; };
    const h = harness({ save: action, share: action });
    await h.api.saveFile('book.json', new Blob(['book'])).catch(() => {});
    await h.share({ files: [new File(['art'], 'art.webp')] }).catch(() => {});
    assert.equal(h.deleted.length, reject ? 2 : 1); assert.equal(h.holds.length, 2);
    assert.equal(h.outputReleases[0].retain, false);
    assert.equal(h.outputReleases[1].retain, !reject);
  }
});
test('partial cache write and partial multi-file share clean their created outputs', async () => {
  let n = 0; const h = harness({ write: async () => { if (++n === 2) throw Error('disk full'); } });
  await assert.rejects(h.share({ files: [new File(['a'], 'a'), new File(['b'], 'b')] }));
  assert.equal(h.deleted.length, 2);
});
test('listener awaits callback before fetching another batch', async () => {
  const h = harness({ batches: [{ files: [f()] }, { files: [f('file:///cache/shared/b')] }] });
  let done, called = 0; h.api.onShared(async () => { called++; if (called === 1) await new Promise(r => { done = r; }); });
  const listener = h.callbacks.get('shared'); const first = listener();
  await new Promise(r => setImmediate(r)); await listener();
  assert.equal(called, 1); assert.equal(h.reads.length, 1);
  done(); await first; assert.equal(called, 2);
});
test('actual Java streaming and canonical-file helpers reject boundary excess and path aliases', async () => {
  const stream = java.slice(java.indexOf('    private static void copyStream('), java.lastIndexOf('\n}'));
  const canonical = java.match(/    private static boolean isSharedFile[\s\S]*?\n    }/)[0];
  const quota = java.match(/    private static boolean outputFits[\s\S]*?\n    }/)[0];
  const active = java.match(/    private static boolean activeOutput[\s\S]*?\n    }/)[0];
  const abandon = java.match(/    private synchronized void abandonSave[\s\S]*?\n    }/)[0];
  const pendingFields = ['pendingSave', 'pendingSaveUri', 'saving'].map(name => java.match(new RegExp('    private volatile [^;]+ ' + name + ';'))[0]).join('\n');
  const job = java.match(/    private static final class IntakeJob[\s\S]*?\n    }/)[0];
  const intakeCopy = java.match(/    private static void copyIntake[\s\S]*?\n    }/)[0];
  const executor = java.slice(java.indexOf('    private static final ThreadPoolExecutor intakeExecutor'), java.indexOf('    private static final ScheduledThreadPoolExecutor intakeTimer'));
  const dir = await mkdtemp(join(tmpdir(), 'tally-cache-test-'));
  const code = `import java.io.*; import java.util.*; import java.util.concurrent.*; public class CacheBoundsTest { ${stream} ${canonical} ${quota} ${active} ${abandon} ${pendingFields} ${job} ${intakeCopy} ${executor}
    private static final long INTAKE_TIMEOUT_SECONDS = 30;
    private static final class CancellationSignal {}
    public static void main(String[] args) throws Exception {
      ByteArrayOutputStream out = new ByteArrayOutputStream(); copyStream(new ByteArrayInputStream(new byte[10]), out, 10);
      if(out.size()!=10) throw new AssertionError("exact bound");
      out.reset(); try { copyStream(new ByteArrayInputStream(new byte[11]), out, 10); throw new AssertionError("over bound"); } catch(IOException expected) {}
      if(out.size()!=0) throw new AssertionError("must check before writing");
      File root = new File(args[0], "shared"); root.mkdirs(); File file = new File(root,"copy"); file.createNewFile();
      if(!isSharedFile(file, root)) throw new AssertionError("valid file");
      if(isSharedFile(new File(root,"../shared/copy"),root)) throw new AssertionError("alias accepted");
      if(isSharedFile(new File(args[0],"out/copy"),root)) throw new AssertionError("outside accepted");
      if(isSharedFile(new File(root,"nested/copy"),root)) throw new AssertionError("nested accepted");
      File outputs = new File(args[0], "out"); outputs.mkdirs(); Map<String,Long> reservations = new HashMap<>();
      File retained = new File(outputs,"retained"); try(RandomAccessFile raf = new RandomAccessFile(retained,"rw")) { raf.setLength(300L*1024*1024); }
      if(outputFits(outputs, reservations, 1,64,300L*1024*1024)) throw new AssertionError("restart must count retained disk bytes");
      try(RandomAccessFile raf = new RandomAccessFile(retained,"rw")) { raf.setLength(3); }
      reservations.put(retained.toURI().toString(), 100L*1024*1024);
      if(outputFits(outputs, reservations, 201L*1024*1024,64,300L*1024*1024)) throw new AssertionError("reservation must count planned bytes");
      if(!outputFits(outputs, reservations, 200L*1024*1024,64,300L*1024*1024)) throw new AssertionError("exact aggregate capacity");
      for(int i=0;i<63;i++) new File(outputs,"file"+i).createNewFile();
      if(outputFits(outputs, reservations, 1,64,300L*1024*1024)) throw new AssertionError("disk file count cap");
      String issued = retained.toURI().toString(); Set<String> leases = new HashSet<>(); leases.add(issued);
      if(!activeOutput(issued,issued,retained,leases,reservations)) throw new AssertionError("active output denied");
      leases.clear(); if(activeOutput(issued,issued,retained,leases,reservations)) throw new AssertionError("retained attachment accepted for save");
      leases.add(issued); if(activeOutput(issued+"/../retained",issued,retained,leases,reservations)) throw new AssertionError("alias accepted for save");
      CacheBoundsTest saveState=new CacheBoundsTest();
      saveState.pendingSave=new File(outputs,"evicted-source"); saveState.pendingSaveUri="file:///owned/evicted-source"; saveState.saving=true;
      saveState.abandonSave("file:///different/save");
      if(!saveState.saving || saveState.pendingSave==null) throw new AssertionError("mismatched callback cleared another save");
      saveState.abandonSave(null);
      if(!saveState.saving) throw new AssertionError("unknown callback cleared another save");
      saveState.abandonSave("file:///owned/evicted-source");
      if(saveState.saving || saveState.pendingSave!=null || saveState.pendingSaveUri!=null) throw new AssertionError("evicted source blocks retry");
      saveState.pendingSave=retained; saveState.pendingSaveUri=null; saveState.saving=true;
      saveState.abandonSave(issued);
      if(!saveState.saving || !retained.exists()) throw new AssertionError("restored callback touched unowned state");
      IntakeJob cancelled = new IntakeJob(10); cancelled.cancelled = true;
      ByteArrayOutputStream cancelledOut = new ByteArrayOutputStream();
      try { copyIntake(new ByteArrayInputStream(new byte[1]),cancelledOut,10,cancelled); throw new AssertionError("cancelled read accepted"); } catch(IOException expected) {}
      if(cancelledOut.size()!=0) throw new AssertionError("cancelled job wrote data");
      IntakeJob duringRead = new IntakeJob(10);
      InputStream cancelRead = new InputStream() { public int read() { return -1; } public int read(byte[] b) { duringRead.cancelled=true; b[0]=1; return 1; } };
      try { copyIntake(cancelRead,cancelledOut,10,duringRead); throw new AssertionError("read cancellation ignored"); } catch(IOException expected) {}
      if(cancelledOut.size()!=0) throw new AssertionError("cancelled provider result written");
      CountDownLatch started=new CountDownLatch(1), unblock=new CountDownLatch(1);
      intakeExecutor.execute(() -> { started.countDown(); boolean done=false; while(!done) try { done=unblock.await(20,TimeUnit.MILLISECONDS); } catch(InterruptedException ignored) {} });
      if(!started.await(2,TimeUnit.SECONDS)) throw new AssertionError("worker never started");
      try { new CacheBoundsTest().intakeExecutor.execute(() -> {}); throw new AssertionError("recreated instance queued a replacement"); } catch(RejectedExecutionException expected) {}
      if(intakeExecutor.getQueue().size()!=0 || intakeExecutor.getPoolSize()!=1) throw new AssertionError("intake unbounded");
      ExecutorService handler=Executors.newSingleThreadExecutor();
      if(handler.submit(() -> 42).get(1,TimeUnit.SECONDS)!=42) throw new AssertionError("plugin handler blocked");
      handler.shutdownNow(); unblock.countDown(); intakeExecutor.shutdownNow();
    } }`;
  await writeFile(join(dir, 'CacheBoundsTest.java'), code);
  const tool = name => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? name + '.exe' : name) : name;
  execFileSync(tool('javac'), [join(dir, 'CacheBoundsTest.java')]);
  execFileSync(tool('java'), ['-cp', dir, 'CacheBoundsTest', dir]);
});

test('provider operations occur outside shared lock and use the dedicated intake executor', () => {
  const receive = java.slice(java.indexOf('    private void receiveShared('), java.indexOf('    private static void copyIntake('));
  for (const match of receive.matchAll(/synchronized \(shared\)\s*\{/g)) {
    let depth = 1, end = match.index + match[0].length;
    const start = end;
    while (depth && end < receive.length) { if(receive[end]==='{') depth++; if(receive[end]==='}') depth--; end++; }
    assert.doesNotMatch(receive.slice(start,end), /getContentResolver|copyIntake|\.query\(|createInputStream/);
  }
  assert.match(java, /intakeExecutor\.execute\(\(\) -> receiveShared/);
  assert.match(java, /private static final AtomicBoolean intakeActive/);
  assert.match(java, /private static final Set<String> intakePaths/);
  assert.match(java, /pendingSaveUri\.equals\(uri\)/);
  assert.match(java, /if \(call == null\) return;/, 'unknown restored save callbacks cannot delete an unrelated pending source');
  assert.match(java, /catch \(Exception error\) \{ abandonSave\(call\.getString\("uri"\)\); call\.reject\("Cannot resume this save/, 'missing-source callback releases only its owned pending slot');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// This deployment regression uses Capacitor's installed getter implementation,
// rather than a mock that silently coerces Integer into Long. Override the root
// when the Android project is deployed elsewhere.
const androidRoot = process.env.TALLY_ANDROID_ROOT || fileURLToPath(new URL('../android-wrapper/', import.meta.url));
const plugin = await readFile(join(androidRoot,'android/app/src/main/java/io/github/tallymy/TallyNativePlugin.java'), 'utf8');
const capacitorCall = await readFile(join(androidRoot,
  'node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/PluginCall.java'), 'utf8');

function method(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `Missing actual bridge getter: ${signature}`);
  let end = source.indexOf('{', start) + 1, depth = 1;
  while (depth && end < source.length) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
    end++;
  }
  return source.slice(start, end).replace(/@Nullable\s*/g, '');
}

test('actual Capacitor numeric getters accept ordinary output sizes and preserve the 300 MiB bound', async () => {
  const getters = [
    'public Integer getInt(String name)',
    'public Integer getInt(String name, @Nullable Integer defaultValue)',
    'public Long getLong(String name)',
    'public Long getLong(String name, @Nullable Long defaultValue)',
  ].map(signature => method(capacitorCall, signature)).join('\n');
  const reserve = plugin.slice(plugin.indexOf('public void reserveOutput('));
  // Include the declaration as shipped, so reverting to getLong reproduces the
  // phone failure instead of passing an equivalent hand-written validator.
  const start = reserve.includes('Integer declaredSize =') ? reserve.indexOf('Integer declaredSize =') : reserve.indexOf('Long size =');
  assert.ok(start >= 0, 'Find shipped output size validation');
  const validation = reserve.slice(start, reserve.indexOf('File dir =', start));
  const cap = plugin.match(/private static final long MAX_SHARED_BYTES = [^;]+;/)?.[0];
  assert.ok(cap, 'Use the shipped native output cap');
  const java = `import java.io.IOException;
public class OutputNumberContract {
  ${cap}
  static class Data { final Object value; Data(Object value) { this.value=value; } Object opt(String name) { return value; } }
  static class Call { final Data data; Call(Object value) { data=new Data(value); } ${getters} }
  static long validate(Object value) throws IOException { Call call=new Call(value); ${validation} return size; }
  static void rejected(Object value) throws Exception {
    // reserveOutput rejects every Exception thrown by this validation block.
    try { validate(value); throw new AssertionError("Invalid size accepted: " + value); } catch(Exception expected) {}
  }
  public static void main(String[] args) throws Exception {
    for(int value : new int[]{0,1,42,1024,3*1024*1024,40*1024*1024,300*1024*1024}) {
      Integer bridgeValue=Integer.valueOf(value);
      if(new Call(bridgeValue).getLong("size") != null) throw new AssertionError("Unexpected Capacitor getLong coercion");
      if(validate(bridgeValue) != value) throw new AssertionError("Ordinary JS integer rejected: " + value);
      if(validate(Long.valueOf(value)) != value) throw new AssertionError("Integral Long rejected: " + value);
    }
    for(Object value : new Object[]{null,"42",Boolean.TRUE,Double.valueOf(42.5),Double.valueOf(42),Double.NaN,Double.POSITIVE_INFINITY,Integer.valueOf(-1),Long.valueOf(-1),Integer.valueOf(300*1024*1024+1),Long.valueOf(300L*1024*1024+1),Integer.valueOf(Integer.MAX_VALUE),Long.valueOf(2147483648L)}) rejected(value);
  }
}`;
  const dir = await mkdtemp(join(tmpdir(), 'tally-output-number-contract-'));
  const source = join(dir, 'OutputNumberContract.java');
  await writeFile(source, java);
  const tool = name => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? name + '.exe' : name) : name;
  execFileSync(tool('javac'), [source]);
  execFileSync(tool('java'), ['-cp', dir, 'OutputNumberContract']);
});

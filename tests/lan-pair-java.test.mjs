import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Compiles the SHIPPED TallyLanPair.java on a JDK and drives it with raw sockets. org.json is Android's, so a tiny flat-object stand-in is
// compiled beside it (the server only builds and parses {"sdp":"..."} objects). Writes only to a temp dir.
// Always this tree's android-wrapper (TALLY_ANDROID_ROOT points at the deployed project, which is not what is under test here).
const root = fileURLToPath(new URL('../android-wrapper/', import.meta.url));
const source = join(root, 'android/app/src/main/java/io/github/tallymy/TallyLanPair.java');
const jdk = process.env.JAVA_HOME;
const javac = jdk && join(jdk, 'bin', 'javac.exe'), java = jdk && join(jdk, 'bin', 'java.exe');
const ready = !!jdk && existsSync(javac) && existsSync(source);

const json = `package org.json;
import java.util.*;
public class JSONObject {
  public static final Object NULL = new Object() { public String toString() { return "null"; } };
  private final LinkedHashMap<String,Object> map = new LinkedHashMap<>();
  public JSONObject() {}
  public JSONObject(String text) throws JSONException {
    int[] at = {0}; text = text.trim(); if (!text.startsWith("{") || !text.endsWith("}")) throw new JSONException("bad");
    at[0] = 1; while (true) { skip(text, at); if (text.charAt(at[0]) == '}') break; String k = str(text, at); skip(text, at); if (text.charAt(at[0]++) != ':') throw new JSONException("bad"); skip(text, at); map.put(k, str(text, at)); skip(text, at); if (text.charAt(at[0]) == ',') at[0]++; }
  }
  private static void skip(String t, int[] a) { while (a[0] < t.length() && Character.isWhitespace(t.charAt(a[0]))) a[0]++; }
  private static String str(String t, int[] a) throws JSONException {
    if (t.charAt(a[0]++) != '"') throw new JSONException("bad"); StringBuilder b = new StringBuilder();
    while (t.charAt(a[0]) != '"') { char c = t.charAt(a[0]++); if (c == '\\\\') { char e = t.charAt(a[0]++); if (e == 'n') b.append('\\n'); else if (e == 'r') b.append('\\r'); else if (e == 'u') { b.append((char) Integer.parseInt(t.substring(a[0], a[0] + 4), 16)); a[0] += 4; } else b.append(e); } else b.append(c); }
    a[0]++; return b.toString();
  }
  public JSONObject put(String k, Object v) { map.put(k, v); return this; }
  public String optString(String k, String d) { Object v = map.get(k); return v instanceof String ? (String) v : d; }
  public int length() { return map.size(); }
  public String toString() {
    StringBuilder b = new StringBuilder("{"); boolean first = true;
    for (Map.Entry<String,Object> e : map.entrySet()) { if (!first) b.append(','); first = false; b.append('"').append(e.getKey()).append("\\":"); Object v = e.getValue();
      if (v instanceof String) { b.append('"'); for (char c : ((String) v).toCharArray()) { if (c == '"' || c == '\\\\') b.append('\\\\').append(c); else if (c == '\\n') b.append("\\\\n"); else if (c == '\\r') b.append("\\\\r"); else b.append(c); } b.append('"'); } else b.append(v); }
    return b.append('}').toString();
  }
}
`;
const exception = 'package org.json; public class JSONException extends Exception { public JSONException(String m) { super(m); } }\n';

const harness = `package io.github.tallymy;
import java.io.*; import java.net.*; import java.nio.charset.StandardCharsets; import java.util.*;
public class PairHarness {
  static final String OK = "https://tallymy.github.io", OTHER = "https://fir1412.github.io";
  static String sdp = "v=0\\r\\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\\r\\na=fingerprint:sha-256 AA\\r\\n";
  static void check(boolean ok, String name) { System.out.println((ok ? "PASS " : "FAIL ") + name); }
  static Socket open(String from, TallyLanPair p) throws Exception {
    Socket s = new Socket(); s.bind(new InetSocketAddress(from, 0)); String[] a = p.address.split(":"); s.connect(new InetSocketAddress(a[0], Integer.parseInt(a[1])), 2000); s.setSoTimeout(15000); return s;
  }
  static int request(TallyLanPair p, String from, String method, String path, String origin, String host, String code, String body) throws Exception {
    try (Socket s = open(from, p)) { return exchange(s, p, method, path, origin, host, code, body); }
  }
  static int exchange(Socket s, TallyLanPair p, String method, String path, String origin, String host, String code, String body) throws Exception {
    StringBuilder b = new StringBuilder(method + " " + path + " HTTP/1.1\\r\\nHost: " + (host == null ? p.address : host) + "\\r\\n");
    if (origin != null) b.append("Origin: ").append(origin).append("\\r\\n");
    if (code != null) b.append("X-Tally-Code: ").append(code).append("\\r\\n");
    if (body != null) b.append("Content-Type: application/json\\r\\nContent-Length: ").append(body.getBytes(StandardCharsets.UTF_8).length).append("\\r\\n");
    b.append("\\r\\n"); if (body != null) b.append(body);
    s.getOutputStream().write(b.toString().getBytes(StandardCharsets.UTF_8)); s.getOutputStream().flush();
    BufferedReader r = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.ISO_8859_1)); String line = r.readLine();
    if (line == null) return -1; return Integer.parseInt(line.split(" ")[1]);
  }
  static String pin(TallyLanPair p) throws Exception { String j = p.status().toString(); int i = j.indexOf("\\"pin\\":\\"") + 7; return j.substring(i, i + 6); }
  static String wrong(String right) { return right.equals("000000") ? "000001" : "000000"; }
  static boolean active(TallyLanPair p) throws Exception { return p.status().toString().contains("\\"active\\":true"); }
  public static void main(String[] args) throws Exception {
    InetAddress lo = InetAddress.getByName("127.0.0.1");
    // 1. stalled connections do not block a legitimate client; trickling is cut by a total deadline
    try (TallyLanPair p = new TallyLanPair(sdp, false, lo)) {
      Socket stalled = open("127.0.0.1", p); Socket stalled2 = open("127.0.0.1", p);
      long t = System.currentTimeMillis(); int code = request(p, "127.0.0.1", "GET", "/offer", OK, null, pin(p), null);
      check(code == 200 && System.currentTimeMillis() - t < 1500, "stalled connections do not block the owner (took " + (System.currentTimeMillis() - t) + " ms)");
      Socket trickle = open("127.0.0.1", p); long t0 = System.currentTimeMillis(); boolean cut = false;
      try { for (int i = 0; i < 12; i++) { trickle.getOutputStream().write('G'); trickle.getOutputStream().flush(); Thread.sleep(1000); } } catch (IOException e) { cut = true; }
      long took = System.currentTimeMillis() - t0; check(cut && took < 8000, "trickling client is cut by the total header deadline (" + took + " ms)");
      stalled.close(); stalled2.close(); trickle.close();
    }
    // 2. four stalled sockets use every worker; the owner is served once they time out
    try (TallyLanPair p = new TallyLanPair(sdp, false, lo)) {
      List<Socket> hold = new ArrayList<>(); for (int i = 0; i < 4; i++) hold.add(open("127.0.0.1", p));
      Thread.sleep(300); long t = System.currentTimeMillis(); int code = -2; while (System.currentTimeMillis() - t < 9000) { try { code = request(p, "127.0.0.1", "GET", "/offer", OK, null, pin(p), null); if (code == 200) break; } catch (IOException e) { code = -1; } Thread.sleep(300); }
      check(code == 200 && System.currentTimeMillis() - t < 7000, "pool is bounded at 4 and recovers after the short deadline (" + (System.currentTimeMillis() - t) + " ms)");
      for (Socket s : hold) s.close();
    }
    // 3. forged / missing / null Origin and wrong Host never consume the owner's attempts
    try (TallyLanPair p = new TallyLanPair(sdp, false, lo)) {
      boolean all403 = true; String right = pin(p);
      for (int i = 0; i < 30; i++) { all403 &= request(p, "127.0.0.1", "GET", "/offer", i % 3 == 0 ? "https://evil.example" : i % 3 == 1 ? "null" : null, null, wrong(right), null) == 403; }
      check(all403, "forged, null and missing Origin get 403");
      check(request(p, "127.0.0.1", "GET", "/offer", OK, "evil.example:1", wrong(right), null) == 400, "wrong Host gets 400");
      check(active(p) && request(p, "127.0.0.1", "GET", "/offer", OK, null, right, null) == 200, "owner still has all attempts after forged traffic");
    }
    // 4. wrong PINs are counted per client address; one address cannot burn the owner's attempts; a total cap still ends the session
    try (TallyLanPair p = new TallyLanPair(sdp, false, lo)) {
      String right = pin(p); boolean ok401 = true;
      for (int i = 0; i < 5; i++) ok401 &= request(p, "127.0.0.2", "GET", "/offer", OK, null, wrong(right), null) == 401;
      check(ok401, "wrong PIN gets 401");
      check(request(p, "127.0.0.2", "GET", "/offer", OK, null, right, null) == 429, "an address with 5 wrong PINs is blocked even with the right PIN");
      check(active(p) && request(p, "127.0.0.1", "GET", "/offer", OK, null, right, null) == 200, "another address (the owner) is not affected");
      for (String ip : new String[] {"127.0.0.3", "127.0.0.4", "127.0.0.5"}) for (int i = 0; i < 5; i++) { try { request(p, ip, "GET", "/offer", OK, null, wrong(right), null); } catch (IOException closed) { /* the session ended */ } }
      check(!active(p), "total wrong-PIN cap (15) closes the session");
    }
    // 5. behaviours verified on the phone stay: preflight, 404, answer once, size limits
    try (TallyLanPair p = new TallyLanPair(sdp, false, lo)) {
      String right = pin(p);
      check(request(p, "127.0.0.1", "OPTIONS", "/offer", OK, null, null, null) == 204 && request(p, "127.0.0.1", "OPTIONS", "/answer", OK, null, null, null) == 204, "204 preflight for the allowed origin");
      check(request(p, "127.0.0.1", "GET", "/other", OK, null, right, null) == 404, "404 elsewhere");
      check(request(p, "127.0.0.1", "POST", "/answer", OK, null, right, "x".repeat(64001)) == 413, "oversized body 413");
      check(request(p, "127.0.0.1", "POST", "/answer", OK, null, right, "{\\"sdp\\":\\"" + sdp.replace("\\r\\n", "\\\\r\\\\n") + "\\"}") == 200, "answer accepted");
      check(request(p, "127.0.0.1", "POST", "/answer", OK, null, right, "{\\"sdp\\":\\"" + sdp.replace("\\r\\n", "\\\\r\\\\n") + "\\"}") == 409, "second answer refused");
    }
    // 6. starvation (re-review PoC): four stall sockets from the SAME address, each reopened the moment the server drops it
    try (TallyLanPair p = new TallyLanPair(sdp, false, lo)) {
      java.util.concurrent.atomic.AtomicBoolean stop = new java.util.concurrent.atomic.AtomicBoolean();
      for (int i = 0; i < 4; i++) { Thread th = new Thread(() -> { while (!stop.get()) { try (Socket s = open("127.0.0.1", p)) { s.setSoTimeout(20000); s.getInputStream().read(); } catch (Exception e) { try { Thread.sleep(1); } catch (Exception x) {} } } }); th.setDaemon(true); th.start(); }
      Thread.sleep(300); int ok = 0, n = 0; long end = System.currentTimeMillis() + 20000;
      while (System.currentTimeMillis() < end) { n++; try { if (request(p, "127.0.0.1", "GET", "/offer", OK, null, pin(p), null) == 200) ok++; } catch (Exception e) { /* counted as a failure */ } Thread.sleep(500); }
      stop.set(true); check(ok >= n - 1 && n >= 36, "owner served under 4 reopening stall sockets on the same address: " + ok + "/" + n);
    }
    // 7. one address sending 130 PIN-less requests cannot end the session or burn the owner's attempts
    try (TallyLanPair p = new TallyLanPair(sdp, false, lo)) {
      Map<Integer, Integer> codes = new TreeMap<>(); for (int i = 0; i < 130; i++) codes.merge(request(p, "127.0.0.2", "GET", "/offer", OK, null, null, null), 1, Integer::sum);
      check(active(p) && codes.get(401) != null && codes.get(401) <= 5 && codes.get(429) >= 120, "130 PIN-less requests from one address: " + codes + ", session still active");
      check(request(p, "127.0.0.1", "GET", "/offer", OK, null, pin(p), null) == 200, "owner on another address still served afterwards");
    }
    // 8. wrong PINs from an already blocked address do not count again toward the total cap
    try (TallyLanPair p = new TallyLanPair(sdp, false, lo)) {
      String right = pin(p); for (int i = 0; i < 40; i++) request(p, "127.0.0.2", "GET", "/offer", OK, null, wrong(right), null);
      check(active(p), "40 wrong PINs from one address (5 counted) leave the session open");
    }
    // 9. the old dev origin is accepted only by debug builds
    try (TallyLanPair p = new TallyLanPair(sdp, false, lo); TallyLanPair d = new TallyLanPair(sdp, true, lo)) {
      check(request(p, "127.0.0.1", "OPTIONS", "/offer", OK, null, null, null) == 204 && request(p, "127.0.0.1", "OPTIONS", "/offer", OTHER, null, null, null) == 403, "release build: tallymy.github.io 204, fir1412.github.io 403");
      check(request(d, "127.0.0.1", "OPTIONS", "/offer", OTHER, null, null, null) == 204, "debug build still accepts the dev origin");
    }
    // 10. aliased-address flood (delta re-review PoC): N addresses x 2 sockets, each sends 500 bytes of a header then stalls, reopened at once
    for (int ips : new int[] {7, 12}) try (TallyLanPair p = new TallyLanPair(sdp, false, lo)) {
      java.util.concurrent.atomic.AtomicBoolean stop = new java.util.concurrent.atomic.AtomicBoolean(); String junk = "X".repeat(500);
      for (int k = 0; k < ips; k++) { final String ip = "127.0.0." + (10 + k); for (int c = 0; c < 2; c++) { Thread th = new Thread(() -> { while (!stop.get()) { try (Socket s = open(ip, p)) { s.getOutputStream().write(("GET /offer HTTP/1.1" + (char) 13 + (char) 10 + "X-Pad: " + junk).getBytes()); s.getOutputStream().flush(); s.setSoTimeout(20000); s.getInputStream().read(); } catch (Exception e) { try { Thread.sleep(1); } catch (Exception x) {} } } }); th.setDaemon(true); th.start(); } }
      Thread.sleep(500); int ok = 0, n = 0; long end = System.currentTimeMillis() + 20000; String right = pin(p);
      while (System.currentTimeMillis() < end) { n++; try { if (request(p, "127.0.0.1", "GET", "/offer", OK, null, right, null) == 200) ok++; } catch (Exception e) { /* failure */ } Thread.sleep(300); }
      stop.set(true); check(ok * 10 >= n * 9 && n >= 55, "owner served under " + ips + " aliased addresses x2 stalled sockets: " + ok + "/" + n);
    }
    System.exit(0);
  }
}
`;

test('TallyLanPair on a JVM: bounded workers, stalled clients, per-address strikes, phone-verified checks', { skip: ready ? false : 'needs JAVA_HOME (JDK 21) and the android-wrapper source', timeout: 400000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lanpair-'));
  await mkdir(join(dir, 'src/org/json'), { recursive: true }); await mkdir(join(dir, 'src/io/github/tallymy'), { recursive: true });
  await writeFile(join(dir, 'src/org/json/JSONObject.java'), json); await writeFile(join(dir, 'src/org/json/JSONException.java'), exception);
  await writeFile(join(dir, 'src/io/github/tallymy/PairHarness.java'), harness);
  await writeFile(join(dir, 'src/io/github/tallymy/TallyLanPair.java'), await readFile(source, 'utf8'));
  execFileSync(javac, ['-d', join(dir, 'out'), ...['org/json/JSONObject.java', 'org/json/JSONException.java', 'io/github/tallymy/TallyLanPair.java', 'io/github/tallymy/PairHarness.java'].map(f => join(dir, 'src', f))], { stdio: 'pipe' });
  const output = execFileSync(java, ['-cp', join(dir, 'out'), 'io.github.tallymy.PairHarness'], { encoding: 'utf8', timeout: 380000 });
  const lines = output.trim().split(/\r?\n/);
  for (const line of lines) assert.ok(line.startsWith('PASS'), line);
  assert.ok(lines.length >= 22, `expected all checks, got ${lines.length}:\n${output}`);
});

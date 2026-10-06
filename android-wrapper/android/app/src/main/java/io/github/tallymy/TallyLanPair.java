package io.github.tallymy;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.*;
import java.util.concurrent.*;
import org.json.JSONObject;

/** Temporary LAN signaling only. Expense records NEVER pass through this HTTP server. */
final class TallyLanPair implements AutoCloseable {
    private final ServerSocket server;
    private final String offer, pin;
    private final boolean debug;
    final String address;
    private final long deadline = System.currentTimeMillis() + 600000;
    private volatile boolean closed;
    private String answer;
    // Each connection runs on a bounded worker so a stalled client cannot block the owner's browser.
    private static final int MAX_WORKERS = 32, QUEUED = 4, PER_IP_CONNS = 2, GRACE_MS = 300, MAX_CONNS = MAX_WORKERS, HEADER_MS = 2000, REQUEST_MS = 5000, PER_IP_BAD_PINS = 5, PER_IP_REQUESTS = 100, TOTAL_BAD_PINS = 15, TOTAL_REQUESTS = 300, FORGED_PER_WINDOW = 120;
    private final ThreadPoolExecutor pool = new ThreadPoolExecutor(MAX_WORKERS, MAX_WORKERS, 0, TimeUnit.MILLISECONDS, new LinkedBlockingQueue<>(QUEUED), r -> { Thread t = new Thread(r, "Tally pairing worker"); t.setDaemon(true); return t; });
    private final List<Conn> conns = new ArrayList<>(); // guarded by itself
    private static final class Conn {
        final Socket socket; final String ip; final long started = System.currentTimeMillis(); volatile int bytes;
        Conn(Socket socket) { this.socket = socket; this.ip = socket.getInetAddress().getHostAddress(); }
    }
    private final Set<String> trusted = ConcurrentHashMap.newKeySet(); // addresses that already sent the right PIN
    /** Eviction candidate: not younger than the grace period, never an address that already proved the PIN (when skipTrusted), and the one that has made the
     *  least progress per millisecond, then the oldest. Returns null when every connection is still young or trusted. */
    private Conn weakest(List<Conn> list, long now, boolean ignoreGrace, boolean skipTrusted) {
        Conn w = null; double wr = 0;
        for (Conn c : list) {
            if (!ignoreGrace && now - c.started < GRACE_MS || skipTrusted && trusted.contains(c.ip)) continue;
            double r = c.bytes / (double) Math.max(1, now - c.started);
            if (w == null || r < wr || r == wr && c.started < w.started) { w = c; wr = r; }
        }
        return w;
    }
    /** At most PER_IP_CONNS sockets per client address and MAX_CONNS overall. A connection younger than GRACE_MS is never evicted: when only young ones are
     *  left the newcomer is refused instead, so a flood cannot churn the table faster than real requests complete. An address that already sent the right PIN
     *  may displace anyone else's connection (reserved capacity for the owner mid-handshake). */
    private boolean admit(Conn c) {
        List<Conn> dropped = new ArrayList<>(); boolean ok = true; long now = System.currentTimeMillis(); boolean trust = trusted.contains(c.ip);
        synchronized (conns) {
            List<Conn> mine = new ArrayList<>(); for (Conn x : conns) if (x.ip.equals(c.ip)) mine.add(x);
            // one address holds at most 2 slots, so its own young sockets may be replaced
            if (mine.size() >= PER_IP_CONNS) { Conn w = weakest(mine, now, false, false); if (w == null) w = weakest(mine, now, true, false); if (w == null) ok = false; else { conns.remove(w); dropped.add(w); } }
            if (ok && conns.size() >= MAX_CONNS) { Conn w = weakest(conns, now, trust, true); if (w == null) ok = false; else { conns.remove(w); dropped.add(w); } }
            if (ok) conns.add(c);
        }
        for (Conn d : dropped) try { d.socket.close(); } catch (IOException ignored) {}
        return ok;
    }
    private final Map<String, int[]> perIp = new HashMap<>(); // {requests, wrong PINs}
    private int badPins, requests, forged;
    private long forgedWindow;
    TallyLanPair(String offer, boolean debug) throws Exception { this(offer, debug, lanAddress()); }
    /** The host is chosen by the caller only in JVM tests; production always uses the Wi-Fi/hotspot address above. */
    TallyLanPair(String offer, boolean debug, InetAddress host) throws Exception {
        this.offer = offer;
        this.debug = debug;
        this.pin = String.format(Locale.ROOT, "%06d", new SecureRandom().nextInt(1000000));
        server = new ServerSocket(); server.bind(new InetSocketAddress(host, 0), 128); server.setSoTimeout(1000);
        address = host.getHostAddress() + ":" + server.getLocalPort();
        Thread thread = new Thread(this::listen, "Tally pairing"); thread.setDaemon(true); thread.start();
    }
    private static InetAddress lanAddress() throws Exception {
        List<NetworkInterface> interfaces = Collections.list(NetworkInterface.getNetworkInterfaces());
        interfaces.sort(Comparator.comparingInt(n -> n.getName().startsWith("wlan") ? 0 : 1));
        InetAddress host = null;
        for (NetworkInterface n : interfaces) {
            if (!n.isUp() || n.isLoopback()) continue;
            // Carrier/VPN private addresses are not a LAN the user's computer can join.
            String name = n.getName();
            if (!(name.startsWith("wlan") || name.startsWith("swlan") || name.startsWith("ap") || name.startsWith("eth") || name.startsWith("rndis") || name.startsWith("usb"))) continue;
            for (InetAddress a : Collections.list(n.getInetAddresses())) if (a instanceof Inet4Address && a.isSiteLocalAddress()) { host = a; break; }
            if (host != null) break;
        }
        if (host == null) throw new IOException("Connect your phone to Wi-Fi or turn on its hotspot, then try again.");
        return host;
    }
    synchronized JSONObject status() throws Exception { return new JSONObject().put("address", address).put("pin", pin).put("active", !closed && System.currentTimeMillis() < deadline).put("answer", answer == null ? JSONObject.NULL : answer); }
    private void listen() {
        try {
            while (!closed && System.currentTimeMillis() < deadline) {
                try {
                    Conn conn = new Conn(server.accept()); if (!admit(conn)) { try { conn.socket.close(); } catch (IOException ignored) {} continue; }
                    try { pool.execute(() -> serve(conn)); } catch (RejectedExecutionException busy) { synchronized (conns) { conns.remove(conn); } try { conn.socket.close(); } catch (IOException ignored) {} }
                } catch (SocketTimeoutException ignored) {}
            }
        } catch (IOException ignored) {} finally { close(); }
    }
    private void serve(Conn conn) {
        try (Socket s = conn.socket) {
            if (closed) return;
            try { handle(conn); } catch (Exception ignored) { /* No request data in logs. */ }
        } catch (IOException ignored) {} finally { synchronized (conns) { conns.remove(conn); } }
    }
    /** Total deadline per phase, not per read: a client that trickles one byte at a time is cut off. */
    private static final class Bounded extends InputStream {
        private final Socket socket; private final InputStream in; private final Conn conn; volatile long limit;
        Bounded(Conn conn, long limit) throws IOException { this.conn = conn; this.socket = conn.socket; this.in = socket.getInputStream(); this.limit = limit; }
        private void arm() throws IOException { long left = limit - System.currentTimeMillis(); if (left <= 0) throw new SocketTimeoutException(); socket.setSoTimeout((int) Math.min(left, 60000)); }
        @Override public int read() throws IOException { arm(); int b = in.read(); if (b >= 0) conn.bytes++; return b; }
        @Override public int read(byte[] b, int off, int len) throws IOException { arm(); int n = in.read(b, off, len); if (n > 0) conn.bytes += n; return n; }
    }
    private static String line(InputStream in) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); int b;
        while ((b = in.read()) != -1) { if (b == '\n') return bytes.toString(StandardCharsets.US_ASCII.name()).replace("\r", ""); if (bytes.size() >= 2048) throw new IOException("Header too large"); bytes.write(b); }
        throw new EOFException();
    }
    private boolean allowed(String origin) {
        return "https://tallymy.github.io".equals(origin) || debug && ("https://fir1412.github.io".equals(origin) || origin != null && origin.matches("http://127\\.0\\.0\\.1:[0-9]{1,5}")); // dev origin and loopback: debug builds only
    }
    private void handle(Conn conn) throws Exception {
        Socket socket = conn.socket;
        long started = System.currentTimeMillis(); Bounded in = new Bounded(conn, started + HEADER_MS); String first = line(in); String[] start = first.split(" ");
        if (start.length != 3) return;
        Map<String, String> headers = new HashMap<>(); int headerBytes = first.length();
        for (int i = 0; i < 30; i++) { String h = line(in); headerBytes += h.length(); if (headerBytes > 8192) return; if (h.isEmpty()) break; int at = h.indexOf(':'); if (at <= 0) return; String key = h.substring(0, at).trim().toLowerCase(Locale.ROOT); if (headers.containsKey(key)) return; headers.put(key, h.substring(at + 1).trim()); if (i == 29) return; }
        String origin = headers.get("origin");
        // A wrong or missing Origin is never counted against the owner's attempts; it only feeds a separate flood limit.
        if (!allowed(origin)) { synchronized (this) { long now = System.currentTimeMillis(); if (now - forgedWindow > 10000) { forgedWindow = now; forged = 0; } if (++forged > FORGED_PER_WINDOW) return; } respond(socket, 403, null, "{}"); return; }
        if (!headers.getOrDefault("host", "").equals(address) || headers.containsKey("transfer-encoding")) { respond(socket, 400, origin, "{}"); return; }
        if (!"/offer".equals(start[1]) && !"/answer".equals(start[1])) { respond(socket, 404, origin, "{}"); return; }
        if ("OPTIONS".equals(start[0])) { respond(socket, 204, origin, ""); return; }
        in.limit = started + REQUEST_MS;
        String ip = conn.ip; boolean limited = false, ended = false;
        synchronized (this) {
            int[] mine = perIp.computeIfAbsent(ip, k -> new int[2]);
            if (closed || System.currentTimeMillis() >= deadline) ended = true;
            // Rate-limited addresses are answered 429 and counted nowhere else: one abusive address can neither burn the owner's attempts nor end the session.
            else if (mine[1] >= PER_IP_BAD_PINS || mine[0] >= PER_IP_REQUESTS) limited = true;
            else { mine[0]++; if (++requests > TOTAL_REQUESTS) ended = true; }
        }
        if (ended) { respond(socket, 410, origin, "{}"); close(); return; }
        if (limited) { respond(socket, 429, origin, "{}"); return; }
        boolean pinOk = pin.equals(headers.get("x-tally-code")); if (pinOk) trusted.add(ip);
        if (!pinOk) {
            respond(socket, 401, origin, "{}");
            // Strikes are per client address; one address cannot burn the owner's attempts. A total cap still ends the session.
            synchronized (this) { perIp.get(ip)[1]++; if (++badPins >= TOTAL_BAD_PINS) close(); }
            return;
        }
        if ("GET".equals(start[0]) && "/offer".equals(start[1])) { respond(socket, 200, origin, new JSONObject().put("sdp", offer).toString()); return; }
        if (!"POST".equals(start[0]) || !"/answer".equals(start[1]) || !"application/json".equals(headers.get("content-type"))) { respond(socket, 400, origin, "{}"); return; }
        int length; try { length = Integer.parseInt(headers.getOrDefault("content-length", "0")); } catch (NumberFormatException error) { return; }
        if (length < 1 || length > 64000) { respond(socket, 413, origin, "{}"); return; }
        byte[] data = new byte[length]; int read = 0;
        while (read < length) { int count = in.read(data, read, length - read); if (count < 0) throw new EOFException(); read += count; }
        JSONObject request = new JSONObject(new String(data, StandardCharsets.UTF_8)); String value = request.optString("sdp", "");
        if (request.length() != 1 || !value.startsWith("v=0\r\n") || !value.contains("m=application ") || value.contains("m=audio ") || value.contains("m=video ") || !value.contains("a=fingerprint:sha-256 ")) { respond(socket, 400, origin, "{}"); return; }
        synchronized (this) { if (answer != null) { respond(socket, 409, origin, "{}"); return; } answer = value; }
        respond(socket, 200, origin, "{}");
    }
    private static void respond(Socket socket, int status, String origin, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        String cors = origin == null ? "" : "Access-Control-Allow-Origin: " + origin + "\r\nVary: Origin\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, X-Tally-Code\r\nAccess-Control-Allow-Private-Network: true\r\n";
        String h = "HTTP/1.1 " + status + " Response\r\n" + cors + "Content-Type: application/json\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\nContent-Length: " + bytes.length + "\r\n\r\n";
        socket.getOutputStream().write(h.getBytes(StandardCharsets.US_ASCII)); socket.getOutputStream().write(bytes); socket.getOutputStream().flush();
    }
    @Override public synchronized void close() { closed = true; try { server.close(); } catch (IOException ignored) {} synchronized (conns) { for (Conn c : conns) try { c.socket.close(); } catch (IOException ignored) {} } pool.shutdownNow(); }
}

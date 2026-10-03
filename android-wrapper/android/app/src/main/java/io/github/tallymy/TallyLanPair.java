package io.github.tallymy;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.*;
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
    private int badPins, requests;
    private Socket current;
    TallyLanPair(String offer, boolean debug) throws Exception {
        this.offer = offer;
        this.debug = debug;
        this.pin = String.format(Locale.ROOT, "%06d", new SecureRandom().nextInt(1000000));
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
        server = new ServerSocket(); server.bind(new InetSocketAddress(host, 0), 8); server.setSoTimeout(1000);
        address = host.getHostAddress() + ":" + server.getLocalPort();
        Thread thread = new Thread(this::listen, "Tally pairing"); thread.setDaemon(true); thread.start();
    }
    synchronized JSONObject status() throws Exception { return new JSONObject().put("address", address).put("pin", pin).put("active", !closed && System.currentTimeMillis() < deadline).put("answer", answer == null ? JSONObject.NULL : answer); }
    private void listen() {
        try {
            while (!closed && System.currentTimeMillis() < deadline) {
                try (Socket socket = server.accept()) {
                    synchronized (this) { current = socket; }
                    socket.setSoTimeout(4000);
                    try { handle(socket); } catch (Exception ignored) { /* No request data in logs. */ }
                    finally { synchronized (this) { current = null; } }
                } catch (SocketTimeoutException ignored) {}
            }
        } catch (IOException ignored) {} finally { close(); }
    }
    private static String line(InputStream in) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); int b;
        while ((b = in.read()) != -1) { if (b == '\n') return bytes.toString(StandardCharsets.US_ASCII.name()).replace("\r", ""); if (bytes.size() >= 2048) throw new IOException("Header too large"); bytes.write(b); }
        throw new EOFException();
    }
    private boolean allowed(String origin) {
        return "https://tallymy.github.io".equals(origin) || "https://fir1412.github.io".equals(origin) || debug && origin != null && origin.matches("http://127\\.0\\.0\\.1:[0-9]{1,5}");
    }
    private void handle(Socket socket) throws Exception {
        InputStream in = socket.getInputStream(); String first = line(in); String[] start = first.split(" ");
        if (start.length != 3) return;
        Map<String, String> headers = new HashMap<>(); int headerBytes = first.length();
        for (int i = 0; i < 30; i++) { String h = line(in); headerBytes += h.length(); if (headerBytes > 8192) return; if (h.isEmpty()) break; int at = h.indexOf(':'); if (at <= 0) return; String key = h.substring(0, at).trim().toLowerCase(Locale.ROOT); if (headers.containsKey(key)) return; headers.put(key, h.substring(at + 1).trim()); if (i == 29) return; }
        String origin = headers.get("origin");
        if (!allowed(origin)) { respond(socket, 403, null, "{}"); return; }
        if (!headers.getOrDefault("host", "").equals(address) || headers.containsKey("transfer-encoding")) { respond(socket, 400, origin, "{}"); return; }
        if (!"/offer".equals(start[1]) && !"/answer".equals(start[1])) { respond(socket, 404, origin, "{}"); return; }
        if ("OPTIONS".equals(start[0])) { respond(socket, 204, origin, ""); return; }
        synchronized (this) { if (++requests > 32 || closed || System.currentTimeMillis() >= deadline) { respond(socket, 410, origin, "{}"); close(); return; } }
        if (!pin.equals(headers.get("x-tally-code"))) {
            respond(socket, 401, origin, "{}"); synchronized (this) { if (++badPins >= 5) close(); } return;
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
    @Override public synchronized void close() { closed = true; try { server.close(); } catch (IOException ignored) {} if (current != null) try { current.close(); } catch (IOException ignored) {} }
}

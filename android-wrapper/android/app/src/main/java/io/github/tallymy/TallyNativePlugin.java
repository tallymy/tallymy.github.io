package io.github.tallymy;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.os.CancellationSignal;
import android.content.res.AssetFileDescriptor;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.atomic.AtomicBoolean;

/** File operations stay within app cache; Android's document picker owns the destination. */
@CapacitorPlugin(name = "TallyNative")
public class TallyNativePlugin extends Plugin {
    private TallyLanPair lanPair;
    private boolean deskForeground = true;
    @PluginMethod public void startLanPair(PluginCall call) {
        String offer = call.getString("offer", "");
        if (offer.length() > 64000 || !offer.startsWith("v=0\r\n") || !offer.contains("m=application ") || offer.contains("m=audio ") || offer.contains("m=video ")) { call.reject("Invalid connection"); return; }
        execute(() -> {
            try {
                synchronized (this) { if (!deskForeground) throw new java.io.IOException("App is not open"); if (lanPair != null) lanPair.close(); lanPair = new TallyLanPair(offer, (getContext().getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0); }
                getActivity().runOnUiThread(() -> { synchronized (this) { if (deskForeground && lanPair != null) getActivity().getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); } });
                call.resolve(JSObject.fromJSONObject(lanPair.status()));
            } catch (Exception error) { call.reject("Connect your phone to Wi-Fi or turn on its hotspot, then try again."); }
        });
    }
    @PluginMethod public synchronized void lanPairStatus(PluginCall call) {
        try { if (lanPair == null) { call.resolve(new JSObject().put("active", false)); return; } call.resolve(JSObject.fromJSONObject(lanPair.status())); }
        catch (Exception error) { call.reject("Connection ended"); }
    }
    @PluginMethod public synchronized void stopLanPair(PluginCall call) {
        if (lanPair != null) { lanPair.close(); lanPair = null; }
        if (!call.getBoolean("keepAwake", false)) getActivity().runOnUiThread(() -> getActivity().getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON));
        call.resolve();
    }
    @Override protected synchronized void handleOnPause() {
        deskForeground = false;
        if (lanPair != null) { lanPair.close(); lanPair = null; }
        getActivity().getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        notifyListeners("deskStopped", new JSObject());
    }
    @Override protected synchronized void handleOnResume() { deskForeground = true; execute(this::cleanCache); }
    @Override protected synchronized void handleOnDestroy() {
        deskForeground = false; if (lanPair != null) { lanPair.close(); lanPair = null; }
        IntakeJob job; synchronized (shared) { job = intakeJob; }
        if (job != null) { job.cancelled = true; if (job.worker != null) job.worker.interrupt(); }
        // Process-wide workers survive recreation; a stuck provider never earns
        // a replacement worker from a new Activity/plugin instance.
    }
    @PluginMethod
    public void scanShortcut(PluginCall call) {
        String button = call.getString("button");
        if (button != null) {
            if (!"off".equals(button) && !"up".equals(button) && !"down".equals(button)) { call.reject("Invalid shortcut button"); return; }
            getContext().getSharedPreferences("tally-shortcut", android.content.Context.MODE_PRIVATE).edit().putString("button", button).apply();
        }
        JSObject result = new JSObject();
        result.put("button", getContext().getSharedPreferences("tally-shortcut", android.content.Context.MODE_PRIVATE).getString("button", "off"));
        call.resolve(result);
    }
    private final List<JSObject> shared = new ArrayList<>();
    private final Map<String, File> sharedCache = new HashMap<>();
    private final Set<String> sharedLeases = new HashSet<>();
    private final Set<String> outputLeases = new HashSet<>();
    private final Map<String, Long> outputReservations = new HashMap<>();
    private String sharedError;
    private volatile File pendingSave;
    private volatile String pendingSaveUri;
    private volatile boolean saving;
    private static final long MAX_SHARED_BYTES = 300L * 1024 * 1024;
    private static final long MAX_IMAGE_BYTES = 40L * 1024 * 1024;
    private static final long CACHE_TTL = 24L * 60 * 60 * 1000;
    private static final int MAX_SHARED_FILES = 8;
    private static final int MAX_OUTPUT_FILES = 64;
    private static final long INTAKE_TIMEOUT_SECONDS = 30;
    private static final String INTAKE_BUSY = "Another shared file is still being read. Try again later.";
    private static final String INTAKE_TIMEOUT = "Reading the shared files took too long. Try sharing a file from Downloads instead.";
    private static final String INTAKE_FAILED = "Could not open shared files. Send up to 8 files, at most 300 MB total and 40 MB per image, then try again.";
    private static final Set<String> intakePaths = java.util.concurrent.ConcurrentHashMap.newKeySet();
    private IntakeJob intakeJob;
    private static final AtomicBoolean intakeActive = new AtomicBoolean();
    private static final ThreadPoolExecutor intakeExecutor = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
        new SynchronousQueue<>(), runnable -> { Thread thread = new Thread(runnable, "tally-intake"); thread.setDaemon(true); return thread; }, new ThreadPoolExecutor.AbortPolicy());
    private static final ScheduledThreadPoolExecutor intakeTimer = new ScheduledThreadPoolExecutor(1, runnable -> {
        Thread thread = new Thread(runnable, "tally-intake-deadline"); thread.setDaemon(true); return thread;
    });
    static { intakeTimer.setRemoveOnCancelPolicy(true); }
    private static final class IntakeJob {
        final long budget, deadline;
        final CancellationSignal signal = new CancellationSignal();
        volatile boolean cancelled, finished;
        volatile Thread worker;
        IntakeJob(long budget) { this.budget = budget; deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(INTAKE_TIMEOUT_SECONDS); }
        void check() throws java.io.IOException {
            if (cancelled || Thread.currentThread().isInterrupted() || System.nanoTime() > deadline) throw new java.io.IOException("Intake cancelled");
        }
    }
    private void intakeError(String message) {
        synchronized (shared) { sharedError = message; }
        notifyListeners("shared", new JSObject(), true);
    }

    @Override public void load() { execute(this::cleanCache); }

    private void cleanCache() {
        synchronized (shared) {
            long cutoff = System.currentTimeMillis() - CACHE_TTL;
            for (String dirName : new String[]{"shared", "out"}) {
                File dir;
                try { dir = new File(getContext().getCacheDir().getCanonicalFile(), dirName); }
                catch (java.io.IOException error) { continue; }
                File[] files = dir.listFiles(); if (files == null) continue;
                for (File f : files) try {
                    File canonical = f.getCanonicalFile();
                    if (!f.getAbsoluteFile().equals(canonical) || !canonical.getParentFile().equals(dir.getCanonicalFile()) || !f.isFile()) continue;
                    String uri = Uri.fromFile(canonical).toString();
                    if (sharedLeases.contains(uri) || intakePaths.contains(uri) || outputLeases.contains(uri) || canonical.equals(pendingSave)) continue;
                    // Orphan intake has no consumer after process death; queued intake expires.
                    if (("shared".equals(dirName) && !sharedCache.containsKey(uri)) || f.lastModified() < cutoff) {
                        if (f.delete()) { sharedCache.remove(uri); shared.removeIf(item -> uri.equals(item.getString("uri"))); }
                    }
                } catch (Exception ignored) {}
            }
        }
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        if (intent == null) return;
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri != null) uris.add(uri);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            ArrayList<Uri> streams = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (streams != null) uris.addAll(streams);
        } else return;
        if (uris.isEmpty() && intent.getClipData() != null) {
            for (int i = 0; i < intent.getClipData().getItemCount(); i++) {
                Uri uri = intent.getClipData().getItemAt(i).getUri();
                if (uri != null) uris.add(uri);
            }
        }
        final String fallbackType = intent.getType();
        IntakeJob job;
        synchronized (shared) {
            cleanCache();
            if (intakeJob != null || intakeActive.get()) { intakeError(INTAKE_BUSY); return; }
            if (uris.isEmpty() || uris.size() > MAX_SHARED_FILES || sharedCache.size() + uris.size() > MAX_SHARED_FILES) { intakeError(INTAKE_FAILED); return; }
            long used = 0; for (File f : sharedCache.values()) used += f.length();
            if (!intakeActive.compareAndSet(false, true)) { intakeError(INTAKE_BUSY); return; }
            job = new IntakeJob(Math.max(0, MAX_SHARED_BYTES - used)); intakeJob = job;
        }
        try { intakeExecutor.execute(() -> receiveShared(uris, fallbackType, job)); }
        catch (java.util.concurrent.RejectedExecutionException error) {
            synchronized (shared) { if (intakeJob == job) intakeJob = null; }
            intakeActive.set(false);
            intakeError(INTAKE_BUSY);
        }
    }

    private void receiveShared(List<Uri> uris, String fallbackType, IntakeJob job) {
        job.worker = Thread.currentThread();
        ScheduledFuture<?> deadlineTask = intakeTimer.schedule(() -> {
            synchronized (shared) { if (job.finished) return; job.cancelled = true; }
            intakeError(INTAKE_TIMEOUT);
            if (job.worker != null) job.worker.interrupt();
            // Do not make a remote Binder cancellation call from the deadline
            // thread. It too can stall. Interrupt/cooperative checks quarantine
            // the sole worker until an uncooperative provider returns.
        }, INTAKE_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        File dir = null;
        List<File> copies = new ArrayList<>(); List<JSObject> batch = new ArrayList<>();
        boolean published = false;
        try {
            dir = new File(getContext().getCacheDir().getCanonicalFile(), "shared");
            if (!dir.isDirectory() && !dir.mkdirs()) throw new java.io.IOException("Cannot create shared cache");
            if (!dir.getAbsoluteFile().equals(dir.getCanonicalFile())) throw new java.io.IOException("Invalid shared cache");
            long total = 0;
            for (Uri uri : uris) {
                job.check();
                if (!"content".equals(uri.getScheme())) throw new java.io.IOException("Unsupported shared URI");
                File copy = new File(dir, UUID.randomUUID().toString());
                copies.add(copy);
                synchronized (shared) { intakePaths.add(Uri.fromFile(copy).toString()); }
                    String name = "shared";
                    long size = -1;
                    try (Cursor cursor = getContext().getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null, job.signal)) {
                        if (cursor != null && cursor.moveToFirst()) {
                            name = cursor.getString(0); if (!cursor.isNull(1)) size = cursor.getLong(1);
                        }
                    }
                    job.check();
                    String mime = getContext().getContentResolver().getType(uri);
                    job.check();
                    if (mime == null) mime = fallbackType == null ? "" : fallbackType;
                    long limit = Math.min(job.budget - total, mime.startsWith("image/") ? MAX_IMAGE_BYTES : job.budget);
                    if (size > limit) throw new java.io.IOException("Shared files are too large");
                    try (AssetFileDescriptor descriptor = getContext().getContentResolver().openAssetFileDescriptor(uri, "r", job.signal)) {
                        job.check();
                        if (descriptor == null) throw new java.io.IOException("Unreadable shared file");
                        try (InputStream in = descriptor.createInputStream(); OutputStream out = new FileOutputStream(copy)) {
                            copyIntake(in, out, limit, job);
                        }
                    }
                    job.check();
                    total += copy.length();
                    JSObject file = new JSObject();
                    file.put("uri", Uri.fromFile(copy).toString());
                    file.put("name", name == null ? "shared" : name);
                    file.put("type", mime); file.put("size", copy.length());
                    batch.add(file);
            }
            synchronized (shared) {
                job.check();
                for (int i = 0; i < batch.size(); i++) sharedCache.put(batch.get(i).getString("uri"), copies.get(i));
                shared.addAll(batch); published = true; job.finished = true;
            }
            notifyListeners("shared", new JSObject(), true);
        } catch (Exception error) {
            if (!job.cancelled) intakeError(System.nanoTime() > job.deadline ? INTAKE_TIMEOUT : INTAKE_FAILED);
        } finally {
            job.finished = true;
            deadlineTask.cancel(false);
            if (!published) for (File f : copies) f.delete();
            synchronized (shared) {
                for (File f : copies) intakePaths.remove(Uri.fromFile(f).toString());
                if (intakeJob == job) intakeJob = null;
            }
            intakeActive.set(false);
            // A stalled call never reaches here, so admission remains closed.
        }
    }

    private static void copyIntake(InputStream in, OutputStream out, long max, IntakeJob job) throws java.io.IOException {
        byte[] buffer = new byte[64 * 1024]; long total = 0; int count;
        while (true) {
            job.check(); count = in.read(buffer); job.check();
            if (count == -1) break;
            total += count; if (total > max) throw new java.io.IOException("Shared file is too large");
            out.write(buffer, 0, count);
        }
    }

    @PluginMethod
    public void takeShared(PluginCall call) {
        JSArray files = new JSArray();
        synchronized (shared) {
            cleanCache();
            for (JSObject file : shared) { files.put(file); sharedLeases.add(file.getString("uri")); }
            shared.clear();
            JSObject result = new JSObject(); result.put("files", files); result.put("error", sharedError); sharedError = null; call.resolve(result);
        }
    }

    @PluginMethod public void releaseShared(PluginCall call) {
        JSArray uris = call.getArray("uris", new JSArray());
        synchronized (shared) {
            for (int i = 0; i < uris.length(); i++) try {
                String uri = uris.getString(i); File tracked = sharedCache.get(uri);
                if (tracked == null || !sharedLeases.contains(uri) || !uri.equals(Uri.fromFile(tracked).toString())) continue;
                File canonical = tracked.getCanonicalFile();
                File root = new File(getContext().getCacheDir(), "shared").getCanonicalFile();
                if (!isSharedFile(tracked, root)) continue;
                if (!tracked.exists() || tracked.delete()) { sharedCache.remove(uri); sharedLeases.remove(uri); }
            } catch (Exception ignored) {}
        }
        call.resolve();
    }

    private static boolean isSharedFile(File tracked, File root) throws java.io.IOException {
        File canonical = tracked.getCanonicalFile();
        return tracked.getAbsoluteFile().equals(canonical) && root.getCanonicalFile().equals(canonical.getParentFile());
    }

    private static boolean outputFits(File dir, Map<String, Long> reservations, long size, int maxFiles, long maxBytes) throws java.io.IOException {
        long total = 0; int count = 0;
        File[] files = dir.listFiles(); if (files == null) throw new java.io.IOException("Cannot inspect output cache");
        for (File f : files) {
            // Count every entry, including suspicious ones, but never delete through it.
            String uri = f.toURI().toString();
            total += Math.max(f.length(), reservations.getOrDefault(uri, 0L)); count++;
        }
        return count < maxFiles && size >= 0 && size <= maxBytes - total;
    }
    @PluginMethod public void reserveOutput(PluginCall call) {
        synchronized (shared) {
            try {
                cleanCache();
                // Capacitor getters are strict; accept either integral JSON
                // representation while retaining the byte cap below.
                Integer declaredSize = call.getInt("size");
                Long size = declaredSize == null ? call.getLong("size") : Long.valueOf(declaredSize.longValue());
                if (size == null || size < 0 || size > MAX_SHARED_BYTES) throw new java.io.IOException("Output is too large");
                // Android may expose its own cache root through a system alias.
                // Canonicalize that trusted root before rejecting child aliases.
                File dir = new File(getContext().getCacheDir().getCanonicalFile(), "out");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new java.io.IOException("Cannot create output cache");
                if (!dir.getAbsoluteFile().equals(dir.getCanonicalFile())) throw new java.io.IOException("Invalid output cache");
                if (!outputFits(dir, outputReservations, size, MAX_OUTPUT_FILES, MAX_SHARED_BYTES)) throw new java.io.IOException("Output cache is full");
                String name = call.getString("name", "file").replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_");
                if (name.length() > 100) name = name.substring(name.length() - 100);
                File file = new File(dir, UUID.randomUUID().toString() + "-" + name);
                if (!file.createNewFile()) throw new java.io.IOException("Cannot reserve output");
                String uri = Uri.fromFile(file).toString();
                outputReservations.put(file.toURI().toString(), size); outputLeases.add(uri);
                JSObject result = new JSObject(); result.put("uri", uri); result.put("path", "out/" + file.getName()); call.resolve(result);
            } catch (Exception error) { call.reject("Too many files to share at once. Try one file at a time."); }
        }
    }
    @PluginMethod public void releaseOutput(PluginCall call) {
        synchronized (shared) {
            String uri = call.getString("uri");
            if (outputLeases.contains(uri)) try {
                File f = cacheOutput(uri);
                if (call.getBoolean("retain", false)) f.setLastModified(System.currentTimeMillis());
                else f.delete();
            } catch (Exception ignored) {}
            try { outputReservations.remove(new File(Uri.parse(uri).getPath()).toURI().toString()); } catch (Exception ignored) {}
            outputLeases.remove(uri);
        }
        call.resolve();
    }

    private File cacheOutput(String uri) throws Exception {
        if (uri == null || !"file".equals(Uri.parse(uri).getScheme())) throw new java.io.IOException("Invalid cache URI");
        File source = new File(Uri.parse(uri).getPath()).getCanonicalFile();
        String root = new File(getContext().getCacheDir(), "out").getCanonicalPath() + File.separator;
        if (!source.getPath().startsWith(root) || !source.isFile()) throw new java.io.IOException("File is outside output cache");
        return source;
    }

    private static boolean activeOutput(String uri, String issuedUri, File source, Set<String> leases, Map<String, Long> reservations) {
        return uri != null && uri.equals(issuedUri) && leases.contains(uri) && reservations.containsKey(source.toURI().toString());
    }

    @PluginMethod
    public void saveToDevice(PluginCall call) {
        File source;
        String uri = call.getString("uri");
        try {
            synchronized (shared) {
                source = cacheOutput(uri);
                if (!activeOutput(uri, Uri.fromFile(source).toString(), source, outputLeases, outputReservations)) throw new java.io.IOException("No active output lease");
            }
        }
        catch (Exception error) { call.reject("Cannot read the cached file"); return; }
        synchronized (this) {
            if (saving) { call.reject("A save is already open"); return; }
            saving = true; pendingSave = source; pendingSaveUri = uri;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mime", "application/octet-stream"));
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", "Tally file"));
        try { startActivityForResult(call, intent, "savedDocument"); }
        catch (Exception error) { finishSave(source); call.reject("No document picker is available"); }
    }

    private File ownedSave(PluginCall call) throws Exception {
        String uri = call.getString("uri"); File source = pendingSave;
        synchronized (shared) {
            if (!saving || source == null || pendingSaveUri == null || !pendingSaveUri.equals(uri) || !activeOutput(uri, Uri.fromFile(source).toString(), source, outputLeases, outputReservations) || !cacheOutput(uri).equals(source)) throw new java.io.IOException("Save ownership was lost");
        }
        return source;
    }
    private synchronized void finishSave(File source) {
        if (source == null || !source.equals(pendingSave)) return;
        source.delete(); pendingSave = null; pendingSaveUri = null; saving = false;
    }
    private synchronized void abandonSave(String callbackUri) {
        // Cache eviction can remove our source while the picker is open. Release
        // only this callback's slot, without deleting a missing/untrusted path.
        if (callbackUri == null || pendingSaveUri == null || !pendingSaveUri.equals(callbackUri)) return;
        pendingSave = null; pendingSaveUri = null; saving = false;
    }

    @ActivityCallback
    private void savedDocument(PluginCall call, ActivityResult activityResult) {
        // A restored/unknown callback carries no owned URI. It must not delete
        // a different save that may currently be pending.
        if (call == null) return;
        final File source;
        try { source = ownedSave(call); }
        catch (Exception error) { abandonSave(call.getString("uri")); call.reject("Cannot resume this save. Try saving again."); return; }
        Uri destination = activityResult.getData() == null ? null : activityResult.getData().getData();
        if (activityResult.getResultCode() != Activity.RESULT_OK || destination == null) {
            finishSave(source);
            JSObject result = new JSObject(); result.put("cancelled", true); call.resolve(result); return;
        }
        execute(() -> {
            try {
                try (InputStream in = new FileInputStream(source); OutputStream out = getContext().getContentResolver().openOutputStream(destination, "wt")) {
                    if (out == null) throw new java.io.IOException("Cannot write destination");
                    copyStream(in, out, Long.MAX_VALUE);
                }
                source.delete();
                JSObject result = new JSObject(); result.put("cancelled", false); call.resolve(result);
            } catch (Exception error) { call.reject("Could not save the file"); }
            finally { finishSave(source); }
        });
    }

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url");
        if (url == null) { call.reject("URL is missing"); return; }
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme();
        if (!java.util.Arrays.asList("https", "http", "mailto", "tel", "geo", "market").contains(scheme)) { call.reject("Unsupported URL"); return; }
        getActivity().runOnUiThread(() -> {
            try { getActivity().startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); call.resolve(); }
            catch (Exception error) { call.reject("No app can open this link"); }
        });
    }

    private static void copyStream(InputStream in, OutputStream out, long max) throws java.io.IOException {
        byte[] buffer = new byte[64 * 1024]; long total = 0; int count;
        while ((count = in.read(buffer)) != -1) {
            total += count; if (total > max) throw new java.io.IOException("Shared file is too large");
            out.write(buffer, 0, count);
        }
    }
}

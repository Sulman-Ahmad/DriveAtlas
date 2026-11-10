package io.github.sulmanahmad.driveatlas;

import android.Manifest;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.graphics.BitmapFactory;
import android.media.ExifInterface;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.StatFs;
import android.os.storage.StorageManager;
import android.os.storage.StorageVolume;
import android.provider.DocumentsContract;
import android.provider.Settings;

import androidx.activity.result.ActivityResult;
import androidx.annotation.RequiresApi;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * DriveAtlas on Android: the phone's storage volumes, storage access, fingerprint unlock, and a folder walker
 * that reports names, sizes and dates (plus the same quick fingerprints and photo/video details as the PC).
 * It never changes, copies or uploads files.
 */
@CapacitorPlugin(
    name = "DriveAtlasStorage",
    permissions = { @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }) }
)
public class DriveAtlasStoragePlugin extends Plugin {

    private static final int BATCH = 400;
    private static final long FP_CHUNK = 64 * 1024;
    private static final int FLAG_HIDDEN = 1;
    private static final int FLAG_DENIED = 4;
    private static final int FLAG_LINK = 8;
    private static final int FLAG_EXCLUDED = 16;
    private static final Set<String> IMAGE_EXTS = new HashSet<>(java.util.Arrays.asList("jpg", "jpeg", "png", "gif", "bmp", "webp"));
    private static final Set<String> VIDEO_EXTS = new HashSet<>(java.util.Arrays.asList("mp4", "m4v", "mov", "3gp", "mkv", "webm", "avi"));

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean cancelled = new AtomicBoolean(false);
    private final AtomicBoolean paused = new AtomicBoolean(false);
    private BroadcastReceiver mediaReceiver;

    @Override
    public void load() {
        mediaReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                notifyListeners("volumesChanged", new JSObject());
            }
        };
        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_MEDIA_MOUNTED);
        filter.addAction(Intent.ACTION_MEDIA_UNMOUNTED);
        filter.addAction(Intent.ACTION_MEDIA_REMOVED);
        filter.addAction(Intent.ACTION_MEDIA_EJECT);
        filter.addAction(Intent.ACTION_MEDIA_BAD_REMOVAL);
        filter.addDataScheme("file");
        ContextCompat.registerReceiver(getContext(), mediaReceiver, filter, ContextCompat.RECEIVER_EXPORTED);
    }

    @Override
    protected void handleOnDestroy() {
        cancelled.set(true);
        if (mediaReceiver != null) {
            try { getContext().unregisterReceiver(mediaReceiver); } catch (Exception ignored) { }
            mediaReceiver = null;
        }
        worker.shutdownNow();
    }

    // ---------- Phone and volumes ----------

    @PluginMethod
    public void info(PluginCall call) {
        JSObject r = new JSObject();
        r.put("manufacturer", Build.MANUFACTURER);
        r.put("model", Build.MODEL);
        r.put("android", Build.VERSION.RELEASE);
        r.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(r);
    }

    @PluginMethod
    public void getVolumes(PluginCall call) {
        JSArray list = new JSArray();
        try {
            if (Build.VERSION.SDK_INT >= 24) {
                StorageManager sm = (StorageManager) getContext().getSystemService(Context.STORAGE_SERVICE);
                List<StorageVolume> volumes = sm.getStorageVolumes();
                for (StorageVolume v : volumes) {
                    File dir = volumeDir(v);
                    String description = v.getDescription(getContext());
                    String lower = description == null ? "" : description.toLowerCase(Locale.ROOT);
                    JSObject o = new JSObject();
                    o.put("id", v.isPrimary() ? "primary" : (v.getUuid() != null ? v.getUuid() : String.valueOf(dir)));
                    o.put("uuid", v.getUuid());
                    o.put("description", description);
                    o.put("primary", v.isPrimary());
                    o.put("removable", v.isRemovable());
                    o.put("usb", !v.isPrimary() && v.isRemovable() && lower.contains("usb"));
                    o.put("state", v.getState());
                    o.put("path", dir == null ? null : dir.getAbsolutePath());
                    putSpace(o, dir);
                    list.put(o);
                }
            } else {
                File dir = Environment.getExternalStorageDirectory();
                JSObject o = new JSObject();
                o.put("id", "primary");
                o.put("uuid", JSONObject.NULL);
                o.put("description", "Internal shared storage");
                o.put("primary", true);
                o.put("removable", false);
                o.put("usb", false);
                o.put("state", Environment.getExternalStorageState());
                o.put("path", dir.getAbsolutePath());
                putSpace(o, dir);
                list.put(o);
            }
        } catch (Exception e) {
            call.reject("Could not read the phone's storage: " + e.getMessage());
            return;
        }
        JSObject r = new JSObject();
        r.put("volumes", list);
        call.resolve(r);
    }

    @RequiresApi(24)
    private File volumeDir(StorageVolume v) {
        if (Build.VERSION.SDK_INT >= 30) return v.getDirectory();
        try {
            Object p = StorageVolume.class.getMethod("getPath").invoke(v);
            if (p != null) return new File(p.toString());
        } catch (Exception ignored) { }
        if (v.isPrimary()) return Environment.getExternalStorageDirectory();
        return v.getUuid() != null ? new File("/storage/" + v.getUuid()) : null;
    }

    private void putSpace(JSObject o, File dir) {
        try {
            if (dir == null) throw new IllegalStateException();
            StatFs st = new StatFs(dir.getAbsolutePath());
            o.put("total", st.getTotalBytes());
            o.put("free", st.getAvailableBytes());
        } catch (Exception e) {
            o.put("total", JSONObject.NULL);
            o.put("free", JSONObject.NULL);
        }
    }

    // ---------- Storage access ----------

    private boolean hasAllFiles() {
        if (Build.VERSION.SDK_INT >= 30) return Environment.isExternalStorageManager();
        return getPermissionState("storage") == PermissionState.GRANTED;
    }

    @PluginMethod
    public void accessStatus(PluginCall call) {
        JSObject r = new JSObject();
        r.put("allFiles", hasAllFiles());
        r.put("needed", true);
        call.resolve(r);
    }

    @PluginMethod
    public void requestAllFilesAccess(PluginCall call) {
        if (hasAllFiles()) { accessResult(call); return; }
        if (Build.VERSION.SDK_INT >= 30) {
            Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
            if (intent.resolveActivity(getContext().getPackageManager()) == null) intent = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
            startActivityForResult(call, intent, "allFilesResult");
        } else {
            requestPermissionForAlias("storage", call, "storagePermissionResult");
        }
    }

    @ActivityCallback
    private void allFilesResult(PluginCall call, ActivityResult result) {
        if (call != null) accessResult(call);
    }

    @PermissionCallback
    private void storagePermissionResult(PluginCall call) {
        accessResult(call);
    }

    private void accessResult(PluginCall call) {
        JSObject r = new JSObject();
        r.put("allFiles", hasAllFiles());
        call.resolve(r);
    }

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "pickFolderResult");
    }

    @ActivityCallback
    private void pickFolderResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject r = new JSObject();
        Intent data = result.getData();
        if (result.getResultCode() == Activity.RESULT_OK && data != null && data.getData() != null) {
            Uri tree = data.getData();
            try {
                getContext().getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) { }
            r.put("uri", tree.toString());
            r.put("name", treeName(tree));
        }
        call.resolve(r);
    }

    private String treeName(Uri tree) {
        try {
            Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
            try (Cursor c = getContext().getContentResolver().query(doc, new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
                if (c != null && c.moveToFirst()) return c.getString(0);
            }
        } catch (Exception ignored) { }
        return null;
    }

    // ---------- Fingerprint ----------

    private static final int AUTHENTICATORS = BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.BIOMETRIC_WEAK;

    @PluginMethod
    public void biometricStatus(PluginCall call) {
        int can = BiometricManager.from(getContext()).canAuthenticate(AUTHENTICATORS);
        JSObject r = new JSObject();
        r.put("available", can == BiometricManager.BIOMETRIC_SUCCESS);
        call.resolve(r);
    }

    @PluginMethod
    public void unlock(PluginCall call) {
        final String title = call.getString("title", "Open DriveAtlas");
        final String subtitle = call.getString("subtitle", "Use your fingerprint");
        final String cancel = call.getString("cancel", "Use PIN");
        final FragmentActivity activity = (FragmentActivity) getActivity();
        activity.runOnUiThread(() -> {
            try {
                BiometricPrompt prompt = new BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                        JSObject r = new JSObject();
                        r.put("ok", true);
                        call.resolve(r);
                    }

                    @Override
                    public void onAuthenticationError(int code, CharSequence message) {
                        JSObject r = new JSObject();
                        r.put("ok", false);
                        r.put("error", message == null ? "" : message.toString());
                        call.resolve(r);
                    }
                });
                BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title)
                    .setSubtitle(subtitle)
                    .setNegativeButtonText(cancel)
                    .setAllowedAuthenticators(AUTHENTICATORS)
                    .build();
                prompt.authenticate(info);
            } catch (Exception e) {
                JSObject r = new JSObject();
                r.put("ok", false);
                r.put("error", e.getMessage());
                call.resolve(r);
            }
        });
    }

    // ---------- Scanning ----------

    @PluginMethod
    public void pauseScan(PluginCall call) { paused.set(true); call.resolve(); }

    @PluginMethod
    public void resumeScan(PluginCall call) { paused.set(false); call.resolve(); }

    @PluginMethod
    public void cancelScan(PluginCall call) { cancelled.set(true); paused.set(false); call.resolve(); }

    @PluginMethod
    public void scan(PluginCall call) {
        final String scanId = call.getString("scanId");
        final String path = call.getString("path");
        final String uri = call.getString("uri");
        JSObject opts = call.getObject("options", new JSObject());
        final boolean wantHidden = opts.optBoolean("hidden", true);
        final boolean wantMedia = opts.optBoolean("media", true);
        final boolean wantFingerprint = opts.optBoolean("fingerprint", true);
        final Set<String> exclude = new HashSet<>();
        JSONArray ex = opts.optJSONArray("exclude");
        if (ex != null) for (int i = 0; i < ex.length(); i++) exclude.add(ex.optString(i, "").toLowerCase(Locale.ROOT));
        if (scanId == null || (path == null && uri == null)) { call.reject("Nothing to scan."); return; }
        cancelled.set(false);
        paused.set(false);
        worker.execute(() -> {
            Walk w = new Walk(scanId, wantHidden, wantMedia, wantFingerprint, exclude);
            try {
                if (uri != null) w.walkTree(Uri.parse(uri)); else w.walkFiles(new File(path));
                w.flush(true);
                JSObject r = new JSObject();
                r.put("files", w.files);
                r.put("folders", w.folders);
                r.put("bytes", w.bytes);
                r.put("skipped", w.skipped);
                r.put("cancelled", cancelled.get());
                call.resolve(r);
            } catch (Exception e) {
                JSObject r = new JSObject();
                r.put("error", e.getMessage() == null ? e.toString() : e.getMessage());
                r.put("cancelled", cancelled.get());
                call.resolve(r);
            }
        });
    }

    /** One scan: walks folders depth first; every child gets a larger number than its folder. */
    private class Walk {
        final String scanId;
        final boolean wantHidden;
        final boolean wantMedia;
        final boolean wantFingerprint;
        final Set<String> exclude;
        int nextEid = 0;
        long files = 0;
        long folders = 0;
        long bytes = 0;
        long skipped = 0;
        JSArray rows = new JSArray();
        long lastSend = System.currentTimeMillis();
        String current = "";

        Walk(String scanId, boolean wantHidden, boolean wantMedia, boolean wantFingerprint, Set<String> exclude) {
            this.scanId = scanId;
            this.wantHidden = wantHidden;
            this.wantMedia = wantMedia;
            this.wantFingerprint = wantFingerprint;
            this.exclude = exclude;
        }

        void waitIfPaused() throws InterruptedException {
            while (paused.get() && !cancelled.get()) Thread.sleep(200);
        }

        void add(int eid, int parent, String name, boolean dir, long size, long mtime, int flags, String fp, Integer width, Integer height, Double duration, Long taken) {
            JSArray row = new JSArray();
            row.put(eid);
            row.put(parent);
            row.put(name);
            row.put(dir ? 1 : 0);
            row.put(size);
            row.put(mtime > 0 ? (Object) mtime : JSONObject.NULL);
            row.put(flags);
            row.put(fp != null ? fp : JSONObject.NULL);
            row.put(width != null ? (Object) width : JSONObject.NULL);
            row.put(height != null ? (Object) height : JSONObject.NULL);
            row.put(duration != null ? (Object) duration : JSONObject.NULL);
            row.put(taken != null ? (Object) taken : JSONObject.NULL);
            rows.put(row);
            if (dir) folders++; else { files++; bytes += size; }
        }

        void flush(boolean force) {
            long now = System.currentTimeMillis();
            if (rows.length() == 0 && !force) return;
            if (!force && rows.length() < BATCH && now - lastSend < 300) return;
            JSObject m = new JSObject();
            m.put("scanId", scanId);
            m.put("entries", rows);
            m.put("current", current);
            notifyListeners("scanBatch", m);
            rows = new JSArray();
            lastSend = now;
        }

        int flagsFor(String name) {
            return name.startsWith(".") ? FLAG_HIDDEN : 0;
        }

        // ----- Plain files (with All files access) -----
        void walkFiles(File root) throws Exception {
            ArrayDeque<Object[]> stack = new ArrayDeque<>();
            stack.push(new Object[] { root, 0 });
            while (!stack.isEmpty()) {
                if (cancelled.get()) return;
                waitIfPaused();
                Object[] top = stack.pop();
                File dir = (File) top[0];
                int dirEid = (Integer) top[1];
                current = dir.getAbsolutePath();
                File[] children = dir.listFiles();
                if (children == null) { skipped++; continue; }
                for (File f : children) {
                    if (cancelled.get()) return;
                    String name = f.getName();
                    int flags = flagsFor(name);
                    if (!wantHidden && (flags & FLAG_HIDDEN) != 0) continue;
                    int eid = ++nextEid;
                    if (isLink(f)) { add(eid, dirEid, name, false, 0, f.lastModified(), flags | FLAG_LINK, null, null, null, null, null); continue; }
                    if (f.isDirectory()) {
                        if (exclude.contains(name.toLowerCase(Locale.ROOT))) {
                            add(eid, dirEid, name, true, 0, f.lastModified(), flags | FLAG_EXCLUDED, null, null, null, null, null);
                            continue;
                        }
                        boolean readable = f.canRead();
                        add(eid, dirEid, name, true, 0, f.lastModified(), readable ? flags : flags | FLAG_DENIED, null, null, null, null, null);
                        if (readable) stack.push(new Object[] { f, eid });
                    } else {
                        long size = f.length();
                        String ext = ext(name);
                        String fp = null;
                        Integer w = null, h = null;
                        Double dur = null;
                        Long taken = null;
                        if (wantFingerprint && size > 0) fp = fingerprint(f, size);
                        if (wantMedia && IMAGE_EXTS.contains(ext)) {
                            BitmapFactory.Options o = new BitmapFactory.Options();
                            o.inJustDecodeBounds = true;
                            BitmapFactory.decodeFile(f.getAbsolutePath(), o);
                            if (o.outWidth > 0) { w = o.outWidth; h = o.outHeight; }
                            if (ext.equals("jpg") || ext.equals("jpeg") || ext.equals("webp")) taken = exifTaken(f);
                        } else if (wantMedia && VIDEO_EXTS.contains(ext)) {
                            MediaMetadataRetriever mr = new MediaMetadataRetriever();
                            try {
                                mr.setDataSource(f.getAbsolutePath());
                                w = parseInt(mr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH));
                                h = parseInt(mr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT));
                                Integer ms = parseInt(mr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION));
                                if (ms != null) dur = ms / 1000.0;
                            } catch (Exception ignored) {
                            } finally {
                                try { mr.release(); } catch (Exception ignored) { }
                            }
                        }
                        add(eid, dirEid, name, false, size, f.lastModified(), flags, fp, w, h, dur, taken);
                    }
                    flush(false);
                }
            }
        }

        // ----- A folder or drive picked with Android's folder picker -----
        void walkTree(Uri tree) throws Exception {
            ContentResolver cr = getContext().getContentResolver();
            ArrayDeque<Object[]> stack = new ArrayDeque<>();
            stack.push(new Object[] { DocumentsContract.getTreeDocumentId(tree), 0 });
            String[] cols = {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED
            };
            while (!stack.isEmpty()) {
                if (cancelled.get()) return;
                waitIfPaused();
                Object[] top = stack.pop();
                String docId = (String) top[0];
                int dirEid = (Integer) top[1];
                Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId);
                try (Cursor c = cr.query(children, cols, null, null, null)) {
                    if (c == null) { skipped++; continue; }
                    while (c.moveToNext()) {
                        if (cancelled.get()) return;
                        String id = c.getString(0);
                        String name = c.getString(1);
                        if (name == null) continue;
                        boolean dir = DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(2));
                        int flags = flagsFor(name);
                        if (!wantHidden && (flags & FLAG_HIDDEN) != 0) continue;
                        long size = c.isNull(3) ? 0 : c.getLong(3);
                        long mtime = c.isNull(4) ? 0 : c.getLong(4);
                        int eid = ++nextEid;
                        current = name;
                        if (dir) {
                            if (exclude.contains(name.toLowerCase(Locale.ROOT))) {
                                add(eid, dirEid, name, true, 0, mtime, flags | FLAG_EXCLUDED, null, null, null, null, null);
                                continue;
                            }
                            add(eid, dirEid, name, true, 0, mtime, flags, null, null, null, null, null);
                            stack.push(new Object[] { id, eid });
                        } else {
                            add(eid, dirEid, name, false, size, mtime, flags, null, null, null, null, null);
                        }
                        flush(false);
                    }
                } catch (SecurityException e) {
                    skipped++;
                }
            }
        }
    }

    private static boolean isLink(File f) {
        try {
            if (Build.VERSION.SDK_INT >= 26) return java.nio.file.Files.isSymbolicLink(f.toPath());
            File parent = f.getParentFile();
            if (parent == null) return false;
            File canonical = new File(parent.getCanonicalFile(), f.getName());
            return !canonical.getCanonicalFile().equals(canonical.getAbsoluteFile());
        } catch (Exception e) {
            return false;
        }
    }

    private static String ext(String name) {
        int i = name.lastIndexOf('.');
        return i > 0 && i < name.length() - 1 ? name.substring(i + 1).toLowerCase(Locale.ROOT) : "";
    }

    private static Integer parseInt(String s) {
        try { return s == null ? null : Integer.valueOf(s.trim()); } catch (Exception e) { return null; }
    }

    /** Same as the PC: SHA-1 of "size:" + the whole file (up to 128 KB) or its first and last 64 KB; first 24 hex digits. */
    private static String fingerprint(File f, long size) {
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            MessageDigest sha = MessageDigest.getInstance("SHA-1");
            sha.update((size + ":").getBytes(StandardCharsets.UTF_8));
            byte[] buf = new byte[(int) FP_CHUNK];
            if (size <= 2 * FP_CHUNK) {
                byte[] all = new byte[(int) size];
                raf.readFully(all);
                sha.update(all);
            } else {
                raf.seek(0);
                raf.readFully(buf);
                sha.update(buf);
                raf.seek(size - FP_CHUNK);
                raf.readFully(buf);
                sha.update(buf);
            }
            byte[] d = sha.digest();
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 12; i++) sb.append(String.format(Locale.ROOT, "%02x", d[i] & 0xff));
            return sb.toString();
        } catch (Exception e) {
            return null;
        }
    }

    /** Date taken from EXIF, read as UTC like the PC does (cameras store local time without a zone). */
    private static Long exifTaken(File f) {
        try {
            ExifInterface exif = new ExifInterface(f.getAbsolutePath());
            String s = exif.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL);
            if (s == null) s = exif.getAttribute(ExifInterface.TAG_DATETIME);
            if (s == null || s.trim().isEmpty()) return null;
            SimpleDateFormat fmt = new SimpleDateFormat("yyyy:MM:dd HH:mm:ss", Locale.ROOT);
            fmt.setTimeZone(TimeZone.getTimeZone("UTC"));
            Date d = fmt.parse(s.trim());
            return d == null ? null : d.getTime();
        } catch (Exception e) {
            return null;
        }
    }
}

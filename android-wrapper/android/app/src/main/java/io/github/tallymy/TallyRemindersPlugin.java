package io.github.tallymy;

import android.Manifest;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(name = "TallyReminders", permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) })
public class TallyRemindersPlugin extends Plugin {
    private PluginCall permissionCall;
    private JSObject status() {
        synchronized (TallyReminderScheduler.LOCK) {
            android.content.SharedPreferences p = TallyReminderScheduler.prefs(getContext());
            boolean permitted = TallyReminderScheduler.allowed(getContext());
            return new JSObject().put("supported", true).put("configured", p.getBoolean("enabled", false)).put("enabled", p.getBoolean("enabled", false) && permitted)
                .put("permission", permitted ? "granted" : "denied").put("eligible", p.getBoolean("eligible", false))
                .put("time", String.format(java.util.Locale.ROOT, "%02d:%02d", p.getInt("minute", 1260) / 60, p.getInt("minute", 1260) % 60));
        }
    }
    @PluginMethod public void reminderStatus(PluginCall call) { call.resolve(status()); }
    @PluginMethod public void mirrorReminderDay(PluginCall call) {
        try {
            String day = call.getString("day", "");
            TallyReminderScheduler.mirror(getContext(), day, call.getBoolean("logged", false), call.getBoolean("eligible", false), call.getString("lang", "en"));
            call.resolve(status());
        } catch (RuntimeException error) { call.reject("Could not update reminder status"); }
    }
    @PluginMethod public synchronized void configureReminder(PluginCall call) {
        try { TallyReminderClock.minute(call.getString("time", "21:00")); } catch (IllegalArgumentException error) { call.reject("Invalid reminder time"); return; }
        if (permissionCall != null) { call.reject("A notification permission request is already open"); return; }
        if (call.getBoolean("enabled", false) && Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            permissionCall = call;
            try { requestPermissionForAlias("notifications", call, "notificationPermission"); }
            catch (RuntimeException error) { permissionCall = null; call.reject("Could not request notification permission"); }
            return;
        }
        apply(call);
    }
    @PermissionCallback private synchronized void notificationPermission(PluginCall call) {
        if (call == null || call != permissionCall) return;
        permissionCall = null;
        apply(call);
    }
    private void apply(PluginCall call) {
        try {
            TallyReminderScheduler.configure(getContext(), call.getBoolean("enabled", false), TallyReminderClock.minute(call.getString("time", "21:00")));
            call.resolve(status());
        } catch (RuntimeException error) { call.reject("Could not save reminder"); }
    }
    @Override protected void handleOnResume() {
        try { TallyReminderScheduler.schedule(getContext()); } catch (RuntimeException error) { TallyReminderScheduler.disable(getContext()); }
    }
}

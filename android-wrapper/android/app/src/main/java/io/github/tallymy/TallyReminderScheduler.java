package io.github.tallymy;

import android.Manifest;
import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import java.util.TimeZone;

/** One local inexact alarm. This class never reads the ledger or uses a network. */
public final class TallyReminderScheduler {
    static final Object LOCK = new Object();
    static final String ACTION = "io.github.tallymy.LOG_REMINDER", CHANNEL = "tally-local-log", PREFS = "tally-local-reminder";
    static final int ID = 3107;
    private static String liveDay = "", liveLang = "en";
    private static boolean liveLogged, liveEligible;
    private TallyReminderScheduler() {}
    static SharedPreferences prefs(Context c) { return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }
    static boolean allowed(Context c) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false;
        if (!NotificationManagerCompat.from(c).areNotificationsEnabled()) return false;
        NotificationChannel channel = Build.VERSION.SDK_INT >= 26 ? c.getSystemService(NotificationManager.class).getNotificationChannel(CHANNEL) : null;
        return channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }
    static String language(String value) { return "ms".equals(value) || "zh".equals(value) || "zh-Hant".equals(value) || "ja".equals(value) || "ta".equals(value) ? value : "en"; }
    static String body(String lang, int index) { return TallyReminderMessages.body(language(lang), index); }
    static PendingIntent alarm(Context c, String day) {
        Intent intent = new Intent(c, TallyReminderReceiver.class).setAction(ACTION);
        if (day != null) intent.putExtra("day", day);
        return PendingIntent.getBroadcast(c, ID, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    static void cancel(Context c) {
        c.getSystemService(AlarmManager.class).cancel(alarm(c, null));
        NotificationManagerCompat.from(c).cancel(ID);
    }
    static void schedule(Context c) {
        synchronized (LOCK) {
            SharedPreferences p = prefs(c);
            cancel(c);
            if (!p.getBoolean("enabled", false) || !p.getBoolean("eligible", false) || !allowed(c) || p.getString("knownDay", "").isEmpty()) return;
            long at = TallyReminderClock.next(System.currentTimeMillis(), p.getInt("minute", 1260), TimeZone.getDefault());
            // Inexact by design: no SCHEDULE_EXACT_ALARM/USE_EXACT_ALARM privilege.
            c.getSystemService(AlarmManager.class).setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, alarm(c, TallyReminderClock.day(at, TimeZone.getDefault())));
        }
    }
    static void disable(Context c) {
        synchronized (LOCK) { prefs(c).edit().putBoolean("enabled", false).remove("knownDay").remove("expenseDay").remove("notifiedDay").remove("eligible").commit(); cancel(c); }
    }
    static void mirror(Context c, String day, boolean logged, boolean eligible, String lang) {
        synchronized (LOCK) {
            if (!TallyReminderClock.day(System.currentTimeMillis(), TimeZone.getDefault()).equals(day)) throw new IllegalArgumentException("Refresh today's reminder status");
            SharedPreferences p = prefs(c);
            liveDay = day; liveLogged = logged; liveEligible = eligible; liveLang = language(lang);
            // Disabled reminders never write expense-date activity outside the encrypted book.
            if (!p.getBoolean("enabled", false)) return;
            boolean changed = !day.equals(p.getString("knownDay", "")) || !((logged ? day : "").equals(p.getString("expenseDay", "")))
                || eligible != p.getBoolean("eligible", false) || !language(lang).equals(p.getString("lang", "en"));
            if (!changed) return;
            if (!p.edit().putString("knownDay", day).putString("expenseDay", logged ? day : "").putBoolean("eligible", eligible).putString("lang", language(lang)).commit()) throw new IllegalStateException("Could not save reminder status");
            if (logged || !eligible) NotificationManagerCompat.from(c).cancel(ID);
            schedule(c);
        }
    }
    static void configure(Context c, boolean enabled, int minute) {
        synchronized (LOCK) {
            if (!enabled) { disable(c); return; }
            if (enabled && !allowed(c)) { disable(c); return; }
            if (!liveEligible || !TallyReminderClock.day(System.currentTimeMillis(), TimeZone.getDefault()).equals(liveDay)) throw new IllegalStateException("Refresh today's reminder status");
            if (!prefs(c).edit().putBoolean("enabled", true).putInt("minute", minute).putString("knownDay", liveDay)
                .putString("expenseDay", liveLogged ? liveDay : "").putBoolean("eligible", liveEligible).putString("lang", liveLang).commit()) throw new IllegalStateException("Could not save reminder");
            try { schedule(c); } catch (RuntimeException error) { disable(c); throw error; }
        }
    }
    static void fire(Context c, String scheduledDay) {
        synchronized (LOCK) {
            SharedPreferences p = prefs(c);
            long now = System.currentTimeMillis(); TimeZone zone = TimeZone.getDefault();
            if (p.getBoolean("enabled", false) && p.getBoolean("eligible", false) && allowed(c)
                && TallyReminderClock.due(now, p.getInt("minute", 1260), zone, scheduledDay, p.getString("knownDay", ""), p.getString("expenseDay", ""), p.getString("notifiedDay", ""))) {
                NotificationManager manager = c.getSystemService(NotificationManager.class);
                if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Tally", NotificationManager.IMPORTANCE_DEFAULT));
                Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                PendingIntent click = PendingIntent.getActivity(c, ID, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                String message = body(p.getString("lang", "en"), p.getInt("messageCursor", 0));
                NotificationCompat.Builder notification = new NotificationCompat.Builder(c, CHANNEL).setSmallIcon(R.drawable.ic_reminder)
                    .setContentTitle("Tally").setContentText(message).setStyle(new NotificationCompat.BigTextStyle().bigText(message)).setContentIntent(click).setAutoCancel(true)
                    .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setOnlyAlertOnce(true);
                // Deduplicate across process death; do not persist notification or ledger content.
                if (p.edit().putString("notifiedDay", TallyReminderClock.day(now, zone))
                    .putInt("messageCursor", TallyReminderMessages.next(p.getInt("messageCursor", 0))).commit()) manager.notify(ID, notification.build());
            }
            // Do not cancel the notification just posted when scheduling tomorrow.
            if (p.getBoolean("enabled", false) && p.getBoolean("eligible", false) && allowed(c)) {
                long at = TallyReminderClock.next(now, p.getInt("minute", 1260), zone);
                c.getSystemService(AlarmManager.class).setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, alarm(c, TallyReminderClock.day(at, zone)));
            }
        }
    }
}

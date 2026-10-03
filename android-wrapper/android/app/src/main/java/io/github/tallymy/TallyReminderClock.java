package io.github.tallymy;

import java.util.Calendar;
import java.util.Locale;
import java.util.TimeZone;

/** Date/time policy shared by production scheduling and plain-Java tests. */
public final class TallyReminderClock {
    private TallyReminderClock() {}
    public static int minute(String time) {
        if (time == null || !time.matches("(?:[01][0-9]|2[0-3]):[0-5][0-9]")) throw new IllegalArgumentException("Invalid reminder time");
        return Integer.parseInt(time.substring(0, 2)) * 60 + Integer.parseInt(time.substring(3));
    }
    public static String day(long now, TimeZone zone) {
        Calendar c = Calendar.getInstance(zone); c.setTimeInMillis(now);
        return String.format(Locale.ROOT, "%04d-%02d-%02d", c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH));
    }
    public static long next(long now, int minute, TimeZone zone) {
        if (minute < 0 || minute >= 1440) throw new IllegalArgumentException("Invalid reminder time");
        Calendar c = Calendar.getInstance(zone); c.setTimeInMillis(now);
        c.set(Calendar.HOUR_OF_DAY, minute / 60); c.set(Calendar.MINUTE, minute % 60); c.set(Calendar.SECOND, 0); c.set(Calendar.MILLISECOND, 0);
        if (c.getTimeInMillis() <= now) {
            // A spring-gap time may normalize 02:30 to 03:30. Move the date
            // from now first, then set the chosen time afresh for tomorrow.
            c.setTimeInMillis(now); c.add(Calendar.DAY_OF_MONTH, 1);
            c.set(Calendar.HOUR_OF_DAY, minute / 60); c.set(Calendar.MINUTE, minute % 60); c.set(Calendar.SECOND, 0); c.set(Calendar.MILLISECOND, 0);
        }
        return c.getTimeInMillis();
    }
    public static boolean due(long now, int minute, TimeZone zone, String scheduledDay, String knownDay, String expenseDay, String notifiedDay) {
        String today = day(now, zone);
        Calendar c = Calendar.getInstance(zone); c.setTimeInMillis(now);
        return !knownDay.isEmpty() && today.equals(scheduledDay) && !today.equals(expenseDay) && !today.equals(notifiedDay)
            && c.get(Calendar.HOUR_OF_DAY) * 60 + c.get(Calendar.MINUTE) >= minute;
    }
}

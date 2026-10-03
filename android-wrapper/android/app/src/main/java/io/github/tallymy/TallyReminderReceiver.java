package io.github.tallymy;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Non-exported; only our immutable alarm and Android lifecycle broadcasts. */
public class TallyReminderReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        try {
            if (TallyReminderScheduler.ACTION.equals(action)) TallyReminderScheduler.fire(context, intent.getStringExtra("day"));
            else if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_TIME_CHANGED.equals(action)
                || Intent.ACTION_TIMEZONE_CHANGED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) TallyReminderScheduler.schedule(context);
        } catch (RuntimeException error) { TallyReminderScheduler.disable(context); }
    }
}

package io.coinos.app;

import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.os.Build;
import android.os.PersistableBundle;

/**
 * This build CAN wake the wallet: it lives in this app's own storage, so a
 * push schedules WakeJob, which loads it off-screen and lets it answer.
 * (The TWA build's version of this class returns false — see src/twa.)
 */
final class Wake {
  private Wake() {}

  static boolean start(Context context, String payload) {
    try {
      JobScheduler js = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
      if (js == null) return false;
      PersistableBundle extras = new PersistableBundle();
      extras.putString("payload", payload == null ? "" : payload);
      JobInfo.Builder b = new JobInfo.Builder(WakeJob.JOB_ID, new ComponentName(context, WakeJob.class))
          .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
          .setExtras(extras);
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        // expedited: runs promptly from the background, which is the whole
        // point — a normal job could wait for hours
        b.setExpedited(true);
      } else {
        b.setOverrideDeadline(0);
      }
      int r = js.schedule(b.build());
      android.util.Log.i("coinos", "wake: schedule -> " + r);
      return r == JobScheduler.RESULT_SUCCESS;
    } catch (Exception e) {
      android.util.Log.w("coinos", "wake: schedule failed: " + e);
      // out of expedited quota, or a manufacturer being creative: the
      // notification is still there
      return false;
    }
  }
}

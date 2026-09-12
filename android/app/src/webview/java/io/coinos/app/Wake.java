package io.coinos.app;

import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * This build CAN wake the wallet: it lives in this app's own storage, so a
 * push starts WakeService, which loads it off-screen and lets it answer.
 * (The TWA build's version of this class returns false — see src/main.)
 */
final class Wake {
  private Wake() {}

  static boolean start(Context context, String payload) {
    try {
      Intent i = new Intent(context, WakeService.class);
      i.putExtra("payload", payload);
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(i);
      else context.startService(i);
      return true;
    } catch (Exception e) {
      // Android refuses background starts in some states; fall back to the
      // notification, which is better than nothing happening at all
      return false;
    }
  }
}

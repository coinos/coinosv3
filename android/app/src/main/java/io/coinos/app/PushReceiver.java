package io.coinos.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;

import org.json.JSONObject;

/**
 * What the distributor says, and what we do about it.
 *
 * <p>A UnifiedPush message wakes THIS app, not the browser — so it can raise
 * a notification, and tapping that opens the wallet, which then answers
 * whatever was waiting on the relay. It cannot answer while still closed the
 * way a service worker does: the wallet's keys live in the browser's storage
 * for its own origin, and nothing here can reach into that. One tap instead
 * of none is the honest version of this on a phone without Play Services.
 */
public class PushReceiver extends BroadcastReceiver {

  private static final String CHANNEL = "coinos";

  @Override
  public void onReceive(Context context, Intent intent) {
    String action = intent.getAction();
    if (action == null) return;
    switch (action) {
      case Push.ACTION_NEW_ENDPOINT: {
        String endpoint = intent.getStringExtra(Push.EXTRA_ENDPOINT);
        if (endpoint != null && !endpoint.isEmpty()) Push.setEndpoint(context, endpoint);
        break;
      }
      case Push.ACTION_REGISTRATION_FAILED:
      case Push.ACTION_UNREGISTERED: {
        Push.prefs(context).edit().remove("endpoint").putBoolean("endpointSent", false).apply();
        break;
      }
      case Push.ACTION_MESSAGE: {
        byte[] bytes = intent.getByteArrayExtra(Push.EXTRA_BYTES_MESSAGE);
        String body = bytes != null ? new String(bytes) : intent.getStringExtra(Push.EXTRA_MESSAGE);
        notify(context, body);
        Push.ack(context, intent.getStringExtra(Push.EXTRA_ID));
        break;
      }
      default:
        break;
    }
  }

  /**
   * The payload is the same JSON the web push path sends. We show what it
   * describes; anything we don't recognise still gets a notification, because
   * silence is the one answer that's always wrong here.
   */
  private void notify(Context c, String payload) {
    String title = c.getString(R.string.app_name);
    String text = c.getString(R.string.push_generic);
    String deepLink = null;
    try {
      JSONObject j = new JSONObject(payload == null ? "{}" : payload);
      String reason = j.optString("reason", j.optString("type", ""));
      if (j.has("title")) title = j.optString("title", title);
      if (j.has("body")) text = j.optString("body", text);
      else if ("payment".equals(reason)) text = c.getString(R.string.push_payment);
      else if ("dm".equals(reason)) text = c.getString(R.string.push_dm);
      else if ("chat".equals(reason)) text = c.getString(R.string.push_chat);
      else if ("nwc".equals(reason) || "request".equals(reason)) text = c.getString(R.string.push_nwc);
      if (j.has("url")) deepLink = j.optString("url", null);
    } catch (Exception ignored) {
      // a payload we can't parse is still a reason to tell the user something
    }

    NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
    if (nm == null) return;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationChannel ch = new NotificationChannel(CHANNEL, c.getString(R.string.app_name),
          NotificationManager.IMPORTANCE_DEFAULT);
      nm.createNotificationChannel(ch);
    }

    Intent open = new Intent(c, LauncherActivity.class);
    open.setAction(Intent.ACTION_VIEW);
    open.setData(Uri.parse(deepLink != null && deepLink.startsWith("https://v3.coinos.io")
        ? deepLink : "https://v3.coinos.io/"));
    open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT
        | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
    PendingIntent pi = PendingIntent.getActivity(c, 0, open, flags);

    Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        ? new Notification.Builder(c, CHANNEL)
        : new Notification.Builder(c);
    b.setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle(title)
        .setContentText(text)
        .setAutoCancel(true)
        .setContentIntent(pi);
    try {
      nm.notify((int) (System.currentTimeMillis() % 100000), b.build());
    } catch (SecurityException e) {
      // POST_NOTIFICATIONS not granted — nothing to be done from a receiver
    }
  }
}

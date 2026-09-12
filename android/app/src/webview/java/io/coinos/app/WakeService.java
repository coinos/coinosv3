package io.coinos.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;

/**
 * The wallet, woken without being opened.
 *
 * <p>A UnifiedPush message starts this service; it loads the wallet into an
 * off-screen WebView — the same storage the visible app uses, because it's
 * the same app — with ?wake= naming what arrived. The page does whatever the
 * payload calls for (answering an NWC request, checking for a payment) and
 * calls back through the CoinosHost bridge when it's finished, or the service
 * gives up after half a minute. Either way it stops: nothing about this is
 * allowed to sit in the background burning battery.
 *
 * <p>A foreground service, because Android will not let a background one
 * touch the network reliably. Its notification IS the point rather than an
 * apology for it — something arrived, and this says so while it's dealt with.
 */
public class WakeService extends Service {

  private static final String CHANNEL = "coinos-wake";
  private static final int NOTIF_ID = 42;
  private static final long GIVE_UP_MS = 30_000;

  private WebView web;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private Runnable giveUp;

  @Override
  public IBinder onBind(Intent intent) { return null; }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    String payload = intent == null ? null : intent.getStringExtra("payload");
    startForeground(NOTIF_ID, notification(payload));

    if (web == null) {
      web = new WebView(this);
      WebSettings s = web.getSettings();
      s.setJavaScriptEnabled(true);
      s.setDomStorageEnabled(true);
      s.setDatabaseEnabled(true);
      web.addJavascriptInterface(new Host(), "CoinosHost");
    }
    // The payload rides in as a parameter the page can read; it carries the
    // event that woke us, so the wallet needn't hunt for it on a relay.
    String url = MainActivity.BASE + "?wake=" + Uri.encode(payload == null ? "1" : payload);
    handler.post(() -> web.loadUrl(url));

    if (giveUp != null) handler.removeCallbacks(giveUp);
    giveUp = this::done;
    handler.postDelayed(giveUp, GIVE_UP_MS);
    return START_NOT_STICKY;
  }

  /** What the page calls when it has finished. */
  private class Host {
    @JavascriptInterface
    public void done() { handler.post(WakeService.this::done); }
    /** Lets the page replace our placeholder notification with the real news. */
    @JavascriptInterface
    public void notify(String title, String body) {
      handler.post(() -> {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        nm.notify(NOTIF_ID + 1, build(title, body, false));
      });
    }
  }

  private void done() {
    if (giveUp != null) handler.removeCallbacks(giveUp);
    if (web != null) { web.destroy(); web = null; }
    stopForeground(true);
    stopSelf();
  }

  @Override
  public void onDestroy() {
    if (web != null) { web.destroy(); web = null; }
    super.onDestroy();
  }

  private Notification notification(String payload) {
    String body = getString(R.string.wake_working);
    try {
      org.json.JSONObject j = new org.json.JSONObject(payload == null ? "{}" : payload);
      String reason = j.optString("reason", j.optString("type", ""));
      if ("nwc".equals(reason)) body = getString(R.string.push_nwc_answering);
      else if ("payment".equals(reason)) body = getString(R.string.push_payment);
      else if ("dm".equals(reason)) body = getString(R.string.push_dm);
      else if ("chat".equals(reason)) body = getString(R.string.push_chat);
    } catch (Exception ignored) {}
    return build(getString(R.string.app_name), body, true);
  }

  private Notification build(String title, String body, boolean quiet) {
    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
      NotificationChannel ch = new NotificationChannel(CHANNEL, getString(R.string.app_name),
          quiet ? NotificationManager.IMPORTANCE_LOW : NotificationManager.IMPORTANCE_DEFAULT);
      nm.createNotificationChannel(ch);
    }
    Intent open = new Intent(this, MainActivity.class);
    open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    int flags = android.app.PendingIntent.FLAG_UPDATE_CURRENT
        | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? android.app.PendingIntent.FLAG_IMMUTABLE : 0);
    Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        ? new Notification.Builder(this, CHANNEL)
        : new Notification.Builder(this);
    return b.setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle(title)
        .setContentText(body)
        .setAutoCancel(true)
        .setContentIntent(android.app.PendingIntent.getActivity(this, 0, open, flags))
        .build();
  }
}

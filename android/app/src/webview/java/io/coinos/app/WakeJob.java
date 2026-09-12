package io.coinos.app;

import android.app.job.JobParameters;
import android.app.job.JobService;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;

/**
 * The wallet, woken without being opened.
 *
 * <p>A push starts this job; it loads the wallet into an off-screen WebView —
 * the same storage the visible app uses, because it's the same app — with
 * ?wake= naming what arrived. The page does whatever the payload calls for
 * (answering an NWC request, checking for a payment) and calls back through
 * the CoinosHost bridge when it's finished, or the job gives up after half a
 * minute. Either way it ends: nothing here is allowed to sit in the
 * background burning battery.
 *
 * <p>A JOB, not a foreground service. Android 12 forbids starting one of
 * those from a broadcast receiver — "Background started FGS: Disallowed" —
 * and an expedited job is the sanctioned replacement: it runs promptly from
 * the background, with no notification of its own to apologise for.
 */
public class WakeJob extends JobService {

  static final int JOB_ID = 4242;
  private static final long GIVE_UP_MS = 30_000;

  private WebView web;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private Runnable giveUp;
  private JobParameters params;

  @Override
  public boolean onStartJob(JobParameters p) {
    params = p;
    String payload = p.getExtras() == null ? null : p.getExtras().getString("payload");
    android.util.Log.i("coinos", "wake: job started, payload=" + payload);

    web = new WebView(this);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setDatabaseEnabled(true);
    web.addJavascriptInterface(new Host(), "CoinosHost");

    // The payload rides in as a parameter the page can read: it carries the
    // event that woke us, so the wallet needn't hunt for it on a relay.
    web.loadUrl(MainActivity.BASE + "?wake=" + Uri.encode(payload == null ? "1" : payload));

    giveUp = () -> finish(false);
    handler.postDelayed(giveUp, GIVE_UP_MS);
    return true; // still working
  }

  @Override
  public boolean onStopJob(JobParameters p) {
    finish(false);
    return false; // don't reschedule: the push will come again if it matters
  }

  /** What the page calls when it has finished. */
  private class Host {
    @JavascriptInterface
    public void done() { handler.post(() -> finish(true)); }
  }

  private void finish(boolean fromPage) {
    android.util.Log.i("coinos", "wake: finishing (" + (fromPage ? "page said so" : "timed out or stopped") + ")");
    if (giveUp != null) { handler.removeCallbacks(giveUp); giveUp = null; }
    if (web != null) { web.destroy(); web = null; }
    if (params != null) { jobFinished(params, false); params = null; }
  }
}

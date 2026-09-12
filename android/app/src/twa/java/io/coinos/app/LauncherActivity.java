package io.coinos.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;

import java.net.URLEncoder;

/**
 * The TWA launcher. Scheme/NFC intents arrive via IntentActivity (the
 * trampoline that survives the running-TWA case); this activity only needs
 * to honor a full URL handed to it, falling back to the site root.
 *
 * <p>It also carries the UnifiedPush endpoint across: the Android side is
 * what a distributor talks to, and the web app is what knows which pubkeys
 * to watch, so the endpoint rides into the web app as ?up= exactly the way
 * payment intents ride in as ?u=.
 */
public class LauncherActivity
    extends com.google.androidbrowserhelper.trusted.LauncherActivity {

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    // Ask the distributor on every launch: it's idempotent, and it's how a
    // distributor installed after us ever gets noticed.
    Push.register(this);
    // Android 13+ won't show our notifications without this, and the TWA's
    // own permission covers the browser's, not ours.
    if (Build.VERSION.SDK_INT >= 33
        && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        && Push.distributor(this) != null) {
      try { requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1); } catch (Exception ignored) {}
    }
  }

  @Override
  protected Uri getLaunchingUrl() {
    Uri data = getIntent().getData();
    Uri base = (data != null && "v3.coinos.io".equals(data.getHost())) ? data : super.getLaunchingUrl();
    String endpoint = Push.endpoint(this);
    if (endpoint == null || Push.endpointDelivered(this)) return base;
    try {
      String sep = base.toString().contains("?") ? "&" : "?";
      Uri withEndpoint = Uri.parse(base + sep + "up=" + URLEncoder.encode(endpoint, "UTF-8"));
      Push.markEndpointDelivered(this);
      return withEndpoint;
    } catch (Exception e) {
      return base;
    }
  }
}

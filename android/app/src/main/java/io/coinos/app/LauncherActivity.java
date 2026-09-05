package io.coinos.app;

import android.net.Uri;

/**
 * The TWA launcher. Scheme/NFC intents arrive via IntentActivity (the
 * trampoline that survives the running-TWA case); this activity only needs
 * to honor a full URL handed to it, falling back to the site root.
 */
public class LauncherActivity
    extends com.google.androidbrowserhelper.trusted.LauncherActivity {

  @Override
  protected Uri getLaunchingUrl() {
    Uri data = getIntent().getData();
    if (data != null && "v3.coinos.io".equals(data.getHost())) return data;
    return super.getLaunchingUrl();
  }
}

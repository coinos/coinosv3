package io.coinos.app;

import android.net.Uri;

/**
 * Forwards scheme intents into the web app. A lightning:/bitcoin:/nostr:/
 * lnurl: URI arrives as this activity's data; the web app receives it as
 * https://v3.coinos.io/?u=<encoded original URI> and routes it (send form
 * for payments, profile for nostr npubs). https links to the site pass
 * through untouched, everything else opens the default URL.
 */
public class LauncherActivity
    extends com.google.androidbrowserhelper.trusted.LauncherActivity {

  @Override
  protected Uri getLaunchingUrl() {
    Uri data = getIntent().getData();
    if (data != null) {
      String scheme = data.getScheme();
      if (scheme != null && !scheme.equals("https") && !scheme.equals("http")) {
        return Uri.parse("https://v3.coinos.io/?u=" + Uri.encode(data.toString()));
      }
      if ("v3.coinos.io".equals(data.getHost())) return data;
    }
    return super.getLaunchingUrl();
  }
}

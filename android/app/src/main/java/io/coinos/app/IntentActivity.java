package io.coinos.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/**
 * Trampoline for scheme + NFC intents. A TWA already on screen ignores a
 * new intent delivered to its (still-alive) launcher, so a second
 * lightning: tap used to do nothing. This activity exists per-intent:
 * it maps the URI to the web app's ?u= form and relaunches LauncherActivity
 * with CLEAR_TOP — the Chrome activity above it is cleared, the launcher is
 * recreated with the new data, and the TWA navigates. Then it's gone.
 */
public class IntentActivity extends android.app.Activity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    Uri url = Uri.parse("https://v3.coinos.io/");
    Uri data = getIntent().getData();
    if (data != null) {
      String scheme = data.getScheme();
      if (scheme != null && !scheme.equals("https") && !scheme.equals("http")) {
        url = Uri.parse("https://v3.coinos.io/?u=" + Uri.encode(data.toString()));
      } else {
        url = data;
      }
    }
    Intent i = new Intent(this, LauncherActivity.class);
    i.setData(url);
    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    startActivity(i);
    finish();
  }
}

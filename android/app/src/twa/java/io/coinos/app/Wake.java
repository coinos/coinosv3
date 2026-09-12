package io.coinos.app;

import android.content.Context;

/**
 * Whether this build can wake the wallet itself.
 *
 * <p>This is the TWA build's answer: no. The wallet lives in Chrome's storage
 * for its own origin, and nothing in this app can reach into that, so a push
 * can only raise a notification for someone to tap. The WebView build has its
 * own version of this class (src/webview) that says yes. One class per
 * flavor, so the shared receiver needs no flavor checks.
 */
final class Wake {
  private Wake() {}

  /** @return true when the wallet was woken and the notification isn't needed. */
  static boolean start(Context context, String payload) {
    return false;
  }
}

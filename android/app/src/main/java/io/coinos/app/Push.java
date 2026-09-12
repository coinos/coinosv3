package io.coinos.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * UnifiedPush, spoken directly.
 *
 * <p>Web push on Android goes through Firebase, so a phone without Google
 * Play Services — GrapheneOS, CalyxOS, any de-Googled Android — cannot be
 * woken by a web app at all. UnifiedPush is the answer that doesn't involve
 * Google: the user installs a distributor (ntfy and friends), apps ask it for
 * an endpoint, and whoever wants to reach the device POSTs to that endpoint.
 *
 * <p>The protocol is four broadcasts each way, so this talks it directly
 * rather than pulling in the connector library — a wrapper this small has no
 * business growing a Kotlin runtime for eight intents.
 *
 * <p>The endpoint is handed to the web app (which is the only part that knows
 * WHAT to watch for) on the next launch, as ?up= on the TWA's URL — the same
 * road payment intents already travel.
 */
public final class Push {
  private Push() {}

  // spoken to the distributor
  static final String ACTION_REGISTER = "org.unifiedpush.android.distributor.REGISTER";
  static final String ACTION_UNREGISTER = "org.unifiedpush.android.distributor.UNREGISTER";
  static final String ACTION_MESSAGE_ACK = "org.unifiedpush.android.distributor.MESSAGE_ACK";
  // heard from it
  static final String ACTION_NEW_ENDPOINT = "org.unifiedpush.android.connector.NEW_ENDPOINT";
  static final String ACTION_REGISTRATION_FAILED = "org.unifiedpush.android.connector.REGISTRATION_FAILED";
  static final String ACTION_UNREGISTERED = "org.unifiedpush.android.connector.UNREGISTERED";
  static final String ACTION_MESSAGE = "org.unifiedpush.android.connector.MESSAGE";

  static final String EXTRA_TOKEN = "token";
  static final String EXTRA_APPLICATION = "application";
  static final String EXTRA_ENDPOINT = "endpoint";
  static final String EXTRA_MESSAGE = "message";
  static final String EXTRA_BYTES_MESSAGE = "bytesMessage";
  static final String EXTRA_ID = "id";

  private static final String PREFS = "unifiedpush";
  private static final String KEY_TOKEN = "token";
  private static final String KEY_DIST = "distributor";
  private static final String KEY_ENDPOINT = "endpoint";
  private static final String KEY_SENT = "endpointSent";
  private static final String KEY_TRY = "tryIndex";
  private static final String KEY_TRY_AT = "tryAt";
  /** How long a distributor gets to answer before we try the next one. */
  private static final long TRY_MS = 60_000;

  static SharedPreferences prefs(Context c) {
    return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  /** Our registration token — one per install, and the distributor's name for us. */
  static String token(Context c) {
    SharedPreferences p = prefs(c);
    String t = p.getString(KEY_TOKEN, null);
    if (t == null) {
      t = UUID.randomUUID().toString();
      p.edit().putString(KEY_TOKEN, t).apply();
    }
    return t;
  }

  /** Every app on the phone that can act as a distributor. */
  static List<String> distributors(Context c) {
    List<String> out = new ArrayList<>();
    Intent probe = new Intent(ACTION_REGISTER);
    for (ResolveInfo ri : c.getPackageManager().queryBroadcastReceivers(probe, 0)) {
      if (ri.activityInfo != null && ri.activityInfo.packageName != null
          && !out.contains(ri.activityInfo.packageName)) {
        out.add(ri.activityInfo.packageName);
      }
    }
    return out;
  }

  /**
   * Which distributor to ask.
   *
   * <p>Not simply the first one installed. Several apps embed a distributor
   * for their own use and export it anyway — a phone here had three, and the
   * first two were Element's and Yakihonne's internal ones, which will never
   * hand an endpoint to anybody else. The spec's answer is to let the user
   * choose, but this app has no settings screen to choose in, so it works
   * through them instead: ask one, and if no endpoint has arrived by the next
   * launch, ask the next. Whoever answers is remembered for good.
   */
  static String distributor(Context c) {
    SharedPreferences p = prefs(c);
    List<String> all = distributors(c);
    if (all.isEmpty()) return null;
    String saved = p.getString(KEY_DIST, null);
    // one that answered, and is still installed, is the one we keep
    if (saved != null && all.contains(saved) && p.getString(KEY_ENDPOINT, null) != null) return saved;
    // otherwise the one we're currently trying, moving on if it's had its
    // chance and produced nothing
    int idx = p.getInt(KEY_TRY, 0);
    long since = p.getLong(KEY_TRY_AT, 0);
    if (saved != null && since > 0 && System.currentTimeMillis() - since > TRY_MS) idx++;
    if (idx >= all.size()) idx = 0;
    String pick = all.get(idx);
    p.edit().putString(KEY_DIST, pick).putInt(KEY_TRY, idx).putLong(KEY_TRY_AT, System.currentTimeMillis()).apply();
    return pick;
  }

  /** Give up on the current distributor; the next call picks another. */
  static void nextDistributor(Context c) {
    SharedPreferences p = prefs(c);
    p.edit().putInt(KEY_TRY, p.getInt(KEY_TRY, 0) + 1).putLong(KEY_TRY_AT, 0).remove(KEY_DIST).apply();
  }

  static String endpoint(Context c) {
    return prefs(c).getString(KEY_ENDPOINT, null);
  }

  static void setEndpoint(Context c, String endpoint) {
    // a NEW endpoint has to reach the web app again, so the "already handed
    // over" mark is cleared with it
    prefs(c).edit().putString(KEY_ENDPOINT, endpoint).putBoolean(KEY_SENT, false).apply();
  }

  /** Whether the web app has already been handed this endpoint. */
  static boolean endpointDelivered(Context c) {
    return prefs(c).getBoolean(KEY_SENT, false);
  }

  static void markEndpointDelivered(Context c) {
    prefs(c).edit().putBoolean(KEY_SENT, true).apply();
  }

  /**
   * Ask the distributor for an endpoint. Cheap and idempotent: a distributor
   * that already knows this token answers with the endpoint it already gave,
   * so this can run on every launch without churn.
   */
  static void register(Context c) {
    String dist = distributor(c);
    if (dist == null) return; // nothing installed to ask
    Intent i = new Intent(ACTION_REGISTER);
    i.setPackage(dist);
    i.putExtra(EXTRA_TOKEN, token(c));
    i.putExtra(EXTRA_APPLICATION, c.getPackageName());
    c.sendBroadcast(i);
  }

  static void unregister(Context c) {
    String dist = distributor(c);
    if (dist == null) return;
    Intent i = new Intent(ACTION_UNREGISTER);
    i.setPackage(dist);
    i.putExtra(EXTRA_TOKEN, token(c));
    c.sendBroadcast(i);
    prefs(c).edit().remove(KEY_ENDPOINT).putBoolean(KEY_SENT, false).apply();
  }

  /** Tell the distributor a message arrived, so it stops resending it. */
  static void ack(Context c, String id) {
    String dist = distributor(c);
    if (dist == null || id == null) return;
    Intent i = new Intent(ACTION_MESSAGE_ACK);
    i.setPackage(dist);
    i.putExtra(EXTRA_TOKEN, token(c));
    i.putExtra(EXTRA_ID, id);
    c.sendBroadcast(i);
  }
}

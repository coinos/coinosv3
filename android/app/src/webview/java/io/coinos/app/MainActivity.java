package io.coinos.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.List;

/**
 * The wallet, in a WebView this app owns.
 *
 * <p>The other build is a TWA — Chrome renders the site, and the wallet's
 * keys live in Chrome's storage. That's the better browser, but it means
 * nothing outside Chrome can wake the wallet, and on a phone without Google
 * Play Services nothing inside Chrome can either. This build trades the
 * browser for reach: the wallet lives in THIS app's storage, so a
 * UnifiedPush message can start it headlessly and let it answer (see
 * WakeService).
 *
 * <p>The trade is real and worth naming: a separate app means a separate
 * wallet. Signing in here is signing in again.
 */
public class MainActivity extends Activity {

  static final String BASE = "https://v3.coinos.io/";
  private WebView web;
  private ValueCallback<Uri[]> filePicker;
  private static final int REQ_FILE = 10, REQ_PERMS = 11;

  @Override
  protected void onCreate(Bundle saved) {
    super.onCreate(saved);
    web = new WebView(this);
    setContentView(web, new ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

    // A debug build can be inspected from a desktop (chrome://inspect); a
    // release build of a wallet must not be — anything with ADB access could
    // read its storage through the same door.
    if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
      WebView.setWebContentsDebuggingEnabled(true);
    }
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);          // localStorage + IndexedDB: the wallet
    s.setDatabaseEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setSupportMultipleWindows(false);
    s.setLoadWithOverviewMode(true);
    s.setUseWideViewPort(true);
    CookieManager.getInstance().setAcceptCookie(true);

    web.setWebViewClient(new WebViewClient() {
      @Override
      public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
        Uri u = r.getUrl();
        String host = u.getHost();
        // our own pages stay in here; everything else is the world's, and
        // belongs in a real browser
        if (host != null && (host.equals("v3.coinos.io") || host.endsWith(".coinos.io"))) return false;
        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
        return true;
      }
    });

    web.setWebChromeClient(new WebChromeClient() {
      @Override
      public void onPermissionRequest(final PermissionRequest request) {
        // the QR scanner asks for the camera; grant it only once Android has
        // granted it to us
        runOnUiThread(() -> {
          if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            request.grant(request.getResources());
          } else {
            request.deny();
            requestPermissions(new String[] { Manifest.permission.CAMERA }, REQ_PERMS);
          }
        });
      }

      @Override
      public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
        // attaching a picture to a post
        if (filePicker != null) filePicker.onReceiveValue(null);
        filePicker = cb;
        try {
          startActivityForResult(params.createIntent(), REQ_FILE);
          return true;
        } catch (Exception e) {
          filePicker = null;
          return false;
        }
      }
    });

    if (Build.VERSION.SDK_INT >= 33
        && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      try { requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, REQ_PERMS); } catch (Exception ignored) {}
    }
    // The page can ask where it's running and whether anything on this phone
    // can deliver a push — the advice it gives is useless otherwise ("use
    // Firefox" makes no sense inside a WebView that IS the app).
    web.addJavascriptInterface(new Host(), "CoinosHost");
    Push.register(this);
    web.loadUrl(urlFor(getIntent()));
  }

  /** What the page is allowed to ask about its surroundings. */
  private class Host {
    @android.webkit.JavascriptInterface
    public String env() {
      String dist = Push.distributor(MainActivity.this);
      List<String> all = Push.distributors(MainActivity.this);
      String endpoint = Push.endpoint(MainActivity.this);
      return "{\"app\":\"graphene\",\"distributors\":" + all.size()
          + ",\"distributor\":" + (dist == null ? "null" : "\"" + dist + "\"")
          + ",\"endpoint\":" + (endpoint != null) + "}";
    }
    /** The wake job's bridge has this too; here it's a no-op. */
    @android.webkit.JavascriptInterface
    public void done() {}
  }

  /** A scheme intent (lightning:, bitcoin:, nostr:) rides in as ?u=, like the TWA's. */
  private String urlFor(Intent intent) {
    StringBuilder url = new StringBuilder(BASE);
    Uri data = intent == null ? null : intent.getData();
    if (data != null) {
      String scheme = data.getScheme();
      if (scheme != null && !scheme.startsWith("http")) url.append("?u=").append(Uri.encode(data.toString()));
      else if ("v3.coinos.io".equals(data.getHost())) { url.setLength(0); url.append(data.toString()); }
    }
    // the UnifiedPush endpoint, on its way to the part of the app that knows
    // what to watch for
    String endpoint = Push.endpoint(this);
    if (endpoint != null && !Push.endpointDelivered(this)) {
      url.append(url.indexOf("?") >= 0 ? "&" : "?").append("up=").append(Uri.encode(endpoint));
      Push.markEndpointDelivered(this);
    }
    return url.toString();
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    if (web != null) web.loadUrl(urlFor(intent));
  }

  @Override
  protected void onActivityResult(int req, int res, Intent data) {
    if (req == REQ_FILE && filePicker != null) {
      filePicker.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data));
      filePicker = null;
      return;
    }
    super.onActivityResult(req, res, data);
  }

  @Override
  public void onBackPressed() {
    if (web != null && web.canGoBack()) web.goBack();
    else super.onBackPressed();
  }
}

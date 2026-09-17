package io.coinos.app;

import android.content.Context;
import android.content.res.AssetManager;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * The bundled web app, served to the WebView from this APK's assets.
 *
 * <p>The page still lives at https://v3.coinos.io/ as far as the WebView is
 * concerned — same origin, same storage, same links — but every file the
 * page asks for under that origin is answered from this APK's assets, the build
 * that shipped in this APK. Only the site's live endpoints (its Electrum
 * and explorer proxies, LNURL, .well-known) go out to the network, exactly
 * the paths the site's own nginx and service worker treat as live. A path
 * with no file behind it and no extension is a deep link (/g/…, /invite/…,
 * /npub…): it gets index.html, as the site's SPA fallback would.
 */
final class Assets {
  private Assets() {}

  static final String HOST = "v3.coinos.io";
  private static final String[] LIVE = { "/electrum", "/esplora/", "/sp/", "/lnurlp/", "/.well-known/", "/api/" };
  private static final Map<String, String> MIME = new HashMap<>();
  static {
    MIME.put("html", "text/html");
    MIME.put("js", "text/javascript");
    MIME.put("mjs", "text/javascript");
    MIME.put("css", "text/css");
    MIME.put("json", "application/json");
    MIME.put("webmanifest", "application/manifest+json");
    MIME.put("png", "image/png");
    MIME.put("webp", "image/webp");
    MIME.put("svg", "image/svg+xml");
    MIME.put("ico", "image/x-icon");
    MIME.put("woff2", "font/woff2");
    MIME.put("wasm", "application/wasm");
    MIME.put("txt", "text/plain");
  }

  /** The asset answering this request, or null to let the network have it. */
  static WebResourceResponse serve(Context ctx, WebResourceRequest req) {
    Uri u = req.getUrl();
    if (u == null || !"https".equals(u.getScheme()) || !HOST.equals(u.getHost())) return null;
    if (!"GET".equalsIgnoreCase(req.getMethod())) return null;
    String path = u.getPath();
    if (path == null || path.isEmpty()) path = "/";
    for (String live : LIVE) if (path.startsWith(live)) return null;
    String rel = path.equals("/") ? "index.html" : path.substring(1);
    AssetManager am = ctx.getAssets();
    InputStream in = open(am, rel);
    if (in == null) {
      String last = rel.substring(rel.lastIndexOf('/') + 1);
      if (last.contains(".")) return null; // a real file we don't carry (coinos.apk): the network's
      rel = "index.html";
      in = open(am, rel);
      if (in == null) return null;
    }
    String ext = rel.substring(rel.lastIndexOf('.') + 1).toLowerCase();
    String mime = MIME.containsKey(ext) ? MIME.get(ext) : "application/octet-stream";
    boolean text = mime.startsWith("text/") || mime.startsWith("application/json") || mime.startsWith("application/manifest") || mime.equals("image/svg+xml");
    WebResourceResponse res = new WebResourceResponse(mime, text ? "utf-8" : null, in);
    Map<String, String> headers = new HashMap<>();
    headers.put("Cache-Control", "no-store");
    res.setResponseHeaders(headers);
    return res;
  }

  private static InputStream open(AssetManager am, String rel) {
    try { return am.open(rel); } catch (IOException e) { return null; }
  }
}

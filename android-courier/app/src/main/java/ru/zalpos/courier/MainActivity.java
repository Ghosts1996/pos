package ru.zalpos.courier;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;

/**
 * Окно приложения курьера: веб-приложение курьера ZalPOS (те же экраны, что
 * в браузере) и мост ZalNative — смена включает фоновую геолокацию
 * (TrackService), чтобы точка курьера шла и при выключенном экране.
 * Ссылки на навигаторы, звонки и чужие сайты открываются снаружи.
 */
public class MainActivity extends Activity {
    private static final int REQ_PERMS = 41;
    private WebView web;
    private String appHost;
    private GeolocationPermissions.Callback pendingGeo;
    private String pendingGeoOrigin;
    private long lastOfflineToast = 0;

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        appHost = Uri.parse(BuildConfig.APP_URL).getHost();
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#F2F4F7"));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " ZalPOSCourier/" + BuildConfig.VERSION_NAME);

        web.addJavascriptInterface(new Bridge(), "ZalNative");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return openOutside(request.getUrl());
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    long now = System.currentTimeMillis();
                    if (now - lastOfflineToast > 60000) {
                        lastOfflineToast = now;
                        Toast.makeText(MainActivity.this, R.string.offline, Toast.LENGTH_LONG).show();
                    }
                    view.postDelayed(() -> view.reload(), 8000);
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (!isOurs(Uri.parse(origin))) {
                    callback.invoke(origin, false, false);
                    return;
                }
                if (hasLocation()) {
                    callback.invoke(origin, true, true);
                } else {
                    pendingGeo = callback;
                    pendingGeoOrigin = origin;
                    askPermissions();
                }
            }
        });

        askPermissions();
        Uri start = getIntent() != null ? getIntent().getData() : null;
        web.loadUrl(start != null && isOurs(start) ? start.toString() : BuildConfig.APP_URL);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Uri u = intent.getData();
        if (u != null && isOurs(u)) web.loadUrl(u.toString());
    }

    private boolean isOurs(Uri u) {
        return u != null && "https".equals(u.getScheme()) && appHost != null && appHost.equalsIgnoreCase(u.getHost());
    }

    /** Свой адрес — внутри; навигатор, звонок, чужой сайт — снаружи. */
    private boolean openOutside(Uri u) {
        if (isOurs(u)) return false;
        try {
            Intent i;
            if ("intent".equals(u.getScheme())) {
                i = Intent.parseUri(u.toString(), Intent.URI_INTENT_SCHEME);
                i.addCategory(Intent.CATEGORY_BROWSABLE);
                i.setComponent(null);
                i.setSelector(null);
            } else {
                i = new Intent(Intent.ACTION_VIEW, u);
            }
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "Нет приложения, чтобы открыть ссылку", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "Ссылка не открылась", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    private boolean hasLocation() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void askPermissions() {
        List<String> want = new ArrayList<>();
        if (!hasLocation()) {
            want.add(Manifest.permission.ACCESS_FINE_LOCATION);
            want.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }
        if (Build.VERSION.SDK_INT >= 33
            && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            want.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (!want.isEmpty()) requestPermissions(want.toArray(new String[0]), REQ_PERMS);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_PERMS || pendingGeo == null) return;
        pendingGeo.invoke(pendingGeoOrigin, hasLocation(), hasLocation());
        pendingGeo = null;
        pendingGeoOrigin = null;
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /** Мост для веб-приложения курьера (window.ZalNative). */
    private class Bridge {
        @JavascriptInterface
        public boolean isNative() {
            return true;
        }

        @JavascriptInterface
        public String version() {
            return BuildConfig.VERSION_NAME;
        }

        /** Смена началась: точка курьера идёт на сервер и при выключенном экране. */
        @JavascriptInterface
        public boolean startTracking(String token, String apiBase) {
            if (token == null || token.length() < 10 || apiBase == null) return false;
            Uri base = Uri.parse(apiBase);
            if (!isOurs(base)) return false;
            if (!hasLocation()) {
                runOnUiThread(MainActivity.this::askPermissions);
                return false;
            }
            TrackService.start(MainActivity.this, token, apiBase);
            return true;
        }

        @JavascriptInterface
        public void stopTracking() {
            TrackService.stop(MainActivity.this);
        }

        @JavascriptInterface
        public boolean isTracking() {
            return TrackService.isRunning();
        }

        @JavascriptInterface
        public void openExternal(String url) {
            if (url == null) return;
            runOnUiThread(() -> openOutside(Uri.parse(url)));
        }
    }

}

package tw.manga.translator;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.os.Message;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.widget.Toast;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.InputStreamReader;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {

    private static final String HOME = "https://www.google.com/";

    private WebView web;
    private EditText urlBar;
    private ProgressBar progress;
    private SharedPreferences prefs;      // 網址等 App 狀態
    private SharedPreferences store;      // 翻譯腳本的設定與快取
    private String injectJs;
    private String userAgent;

    private final Set<String> adHosts = new HashSet<>();
    private long lastToast = 0;

    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private final Map<String, String> results = new ConcurrentHashMap<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("app", MODE_PRIVATE);
        store = getSharedPreferences("gm", MODE_PRIVATE);
        injectJs = buildInjectJs();
        loadAdHosts();
        buildUi();

        String start = urlFromIntent(getIntent());
        if (start == null) start = prefs.getString("last", HOME);
        web.loadUrl(start);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String u = urlFromIntent(intent);
        if (u != null) web.loadUrl(u);
    }

    private String urlFromIntent(Intent intent) {
        if (intent == null) return null;
        if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            return intent.getData().toString();
        }
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            String t = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (t != null) {
                java.util.regex.Matcher m = java.util.regex.Pattern.compile("https?://\\S+").matcher(t);
                if (m.find()) return m.group();
            }
        }
        return null;
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private void buildUi() {
        LinearLayout rootView = new LinearLayout(this);
        rootView.setOrientation(LinearLayout.VERTICAL);
        rootView.setBackgroundColor(Color.WHITE);

        // 上方網址列
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(6), dp(4), dp(6), dp(4));
        bar.setBackgroundColor(Color.parseColor("#F1F3F5"));

        urlBar = new EditText(this);
        urlBar.setSingleLine(true);
        urlBar.setHint("輸入網址或搜尋");
        urlBar.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        urlBar.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        urlBar.setImeOptions(EditorInfo.IME_ACTION_GO);
        urlBar.setSelectAllOnFocus(true);
        urlBar.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_GO
                    || (event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER)) {
                go(urlBar.getText().toString());
                return true;
            }
            return false;
        });
        bar.addView(urlBar, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button reload = smallButton("⟳");
        reload.setOnClickListener(v -> web.reload());
        bar.addView(reload);

        Button settings = smallButton("⚙");
        settings.setOnClickListener(v ->
                web.evaluateJavascript("window.__mtOpenSettings && window.__mtOpenSettings();", null));
        bar.addView(settings);

        rootView.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        rootView.addView(progress, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3)));

        web = new WebView(this);
        rootView.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(rootView);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        // 開新視窗一律先攔下來判斷，擋掉彈出廣告
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        // 拿掉 WebView 標記，讓網站當成一般 Chrome
        userAgent = s.getUserAgentString().replace("; wv)", ")");
        s.setUserAgentString(userAgent);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.addJavascriptInterface(new Bridge(), "MTBridge");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
                if ("http".equals(scheme) || "https".equals(scheme)) {
                    if (!request.isForMainFrame()) return false;
                    String host = u.getHost();
                    if (isAdHost(host)) { blocked(); return true; }
                    // 沒有點擊、也不是伺服器轉址，卻自己跳到別的網站 → 多半是廣告
                    if (!request.hasGesture() && !request.isRedirect()
                            && !sameSite(host, Uri.parse(String.valueOf(view.getUrl())).getHost())) {
                        blocked();
                        return true;
                    }
                    return false;
                }
                // intent:、market: 常被廣告拿來硬開 Play 商店，直接擋
                if ("intent".equals(scheme) || "market".equals(scheme) || !request.hasGesture()) {
                    blocked();
                    return true;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (isAdHost(request.getUrl().getHost())) {
                    return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
                }
                return null;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                if (!urlBar.hasFocus()) urlBar.setText(url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (!urlBar.hasFocus()) urlBar.setText(url);
                prefs.edit().putString("last", url).apply();
                view.evaluateJavascript(injectJs, null);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                if (!isUserGesture) { blocked(); return false; }
                // 用一個看不見的暫存視窗接住新網址，再決定要不要開
                final String currentHost = Uri.parse(String.valueOf(view.getUrl())).getHost();
                WebView probe = new WebView(MainActivity.this);
                probe.setWebViewClient(new WebViewClient() {
                    private boolean handled = false;

                    private void decide(WebView w, String url) {
                        if (handled || url == null || url.startsWith("about:")) return;
                        handled = true;
                        String host = Uri.parse(url).getHost();
                        if (!isAdHost(host) && sameSite(host, currentHost)) web.loadUrl(url);
                        else blocked();
                        w.stopLoading();
                        w.destroy();
                    }

                    @Override
                    public boolean shouldOverrideUrlLoading(WebView w, WebResourceRequest r) {
                        decide(w, r.getUrl().toString());
                        return true;
                    }

                    @Override
                    public void onPageStarted(WebView w, String url, Bitmap favicon) {
                        decide(w, url);
                    }
                });
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(probe);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progress.setProgress(newProgress);
                progress.setVisibility(newProgress >= 100 ? View.INVISIBLE : View.VISIBLE);
                // 頁面大致載好就先注入，漫畫圖片可以早點開始翻
                if (newProgress >= 70) view.evaluateJavascript(injectJs, null);
            }
        });
    }

    private void loadAdHosts() {
        try (BufferedReader r = new BufferedReader(new InputStreamReader(getAssets().open("adhosts.txt"), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                line = line.trim().toLowerCase();
                if (!line.isEmpty() && !line.startsWith("#")) adHosts.add(line);
            }
        } catch (Exception ignored) {
        }
    }

    private boolean isAdHost(String host) {
        if (host == null) return false;
        String h = host.toLowerCase();
        while (true) {
            if (adHosts.contains(h)) return true;
            int dot = h.indexOf('.');
            if (dot < 0) return false;
            h = h.substring(dot + 1);
        }
    }

    // 取網域最後兩段比較（例：www.abc.com 與 img.abc.com 視為同一站）
    private static String baseDomain(String host) {
        if (host == null) return "";
        String[] p = host.toLowerCase().split("\\.");
        if (p.length <= 2) return host.toLowerCase();
        String last2 = p[p.length - 2] + "." + p[p.length - 1];
        // 像 .com.tw、.co.jp 這種要取三段
        if (p[p.length - 2].length() <= 3 && p[p.length - 1].length() == 2 && p.length >= 3) {
            return p[p.length - 3] + "." + last2;
        }
        return last2;
    }

    private static boolean sameSite(String a, String b) {
        if (a == null || b == null) return false;
        return baseDomain(a).equals(baseDomain(b));
    }

    private void blocked() {
        runOnUiThread(() -> {
            long now = System.currentTimeMillis();
            if (now - lastToast > 3000) {
                lastToast = now;
                Toast.makeText(this, "已擋下廣告", Toast.LENGTH_SHORT).show();
            }
        });
    }

    private Button smallButton(String text) {
        Button b = new Button(this);
        b.setText(text);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        b.setMinWidth(0);
        b.setMinimumWidth(0);
        b.setPadding(dp(10), 0, dp(10), 0);
        b.setBackgroundColor(Color.TRANSPARENT);
        return b;
    }

    private void go(String input) {
        String t = input.trim();
        if (t.isEmpty()) return;
        String url;
        if (t.matches("(?i)^https?://.*")) {
            url = t;
        } else if (!t.contains(" ") && t.contains(".")) {
            url = "https://" + t;
        } else {
            url = "https://www.google.com/search?q=" + Uri.encode(t);
        }
        web.loadUrl(url);
        urlBar.clearFocus();
        web.requestFocus();
        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (imm != null) imm.hideSoftInputFromWindow(urlBar.getWindowToken(), 0);
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name)) {
            return new String(readAll(in), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }

    private String buildInjectJs() {
        return "(function(){if(window.__mtLoaded||!document.documentElement)return;window.__mtLoaded=true;\n"
                + readAsset("shim.js") + "\n"
                + readAsset("translator.js")
                + "\n})();";
    }

    private static byte[] readAll(InputStream in) throws java.io.IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    /** 給網頁裡的翻譯腳本呼叫的 Java 介面 */
    private class Bridge {

        @JavascriptInterface
        public String get(String key) {
            return store.getString(key, null);
        }

        @JavascriptInterface
        public void set(String key, String value) {
            store.edit().putString(key, value).apply();
        }

        @JavascriptInterface
        public String take(String id) {
            return results.remove(id);
        }

        // 由 App 代為連網：不受網頁跨網域限制，可以抓漫畫圖片和呼叫 Gemini
        @JavascriptInterface
        public void xhr(final String id, final String method, final String url, final String headersJson,
                        final String body, final boolean binary, final int timeoutMs) {
            pool.execute(() -> {
                JSONObject r = new JSONObject();
                HttpURLConnection c = null;
                try {
                    c = (HttpURLConnection) new URL(url).openConnection();
                    c.setRequestMethod(method);
                    c.setConnectTimeout(20000);
                    c.setReadTimeout(Math.max(10000, timeoutMs));
                    c.setInstanceFollowRedirects(true);
                    c.setRequestProperty("User-Agent", userAgent);
                    if (!url.contains("googleapis.com")) {
                        String cookie = CookieManager.getInstance().getCookie(url);
                        if (cookie != null) c.setRequestProperty("Cookie", cookie);
                        c.setRequestProperty("Accept", "image/avif,image/webp,image/*,*/*;q=0.8");
                    }
                    JSONObject h = new JSONObject(headersJson == null || headersJson.isEmpty() ? "{}" : headersJson);
                    Iterator<String> keys = h.keys();
                    while (keys.hasNext()) {
                        String k = keys.next();
                        c.setRequestProperty(k, h.getString(k));
                    }
                    if (body != null && !body.isEmpty()) {
                        c.setDoOutput(true);
                        try (OutputStream os = c.getOutputStream()) {
                            os.write(body.getBytes(StandardCharsets.UTF_8));
                        }
                    }
                    int status = c.getResponseCode();
                    InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                    byte[] data = in == null ? new byte[0] : readAll(in);
                    if (in != null) in.close();
                    r.put("status", status);
                    r.put("contentType", c.getContentType() == null ? "" : c.getContentType());
                    if (binary && status < 400) {
                        r.put("body", Base64.encodeToString(data, Base64.NO_WRAP));
                    } else {
                        r.put("body", new String(data, StandardCharsets.UTF_8));
                    }
                } catch (SocketTimeoutException e) {
                    try { r.put("error", "timeout"); r.put("timeout", true); } catch (Exception ignored) { }
                } catch (Exception e) {
                    try { r.put("error", String.valueOf(e)); } catch (Exception ignored) { }
                } finally {
                    if (c != null) c.disconnect();
                }
                results.put(id, r.toString());
                final String js = "window.__mtXhrDone && window.__mtXhrDone(" + JSONObject.quote(id) + ");";
                runOnUiThread(() -> web.evaluateJavascript(js, null));
            });
        }
    }
}

package tw.vizh.translator;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {

    private WebView web;
    private SpeechRecognizer recognizer;
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private final ExecutorService pool = Executors.newFixedThreadPool(3);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(), "Android");
        setContentView(web);
        web.loadUrl("file:///android_asset/index.html");

        tts = new TextToSpeech(this, status -> ttsReady = (status == TextToSpeech.SUCCESS));

        if (Build.VERSION.SDK_INT >= 23
                && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 1);
        }
    }

    @Override
    protected void onDestroy() {
        if (recognizer != null) recognizer.destroy();
        if (tts != null) tts.shutdown();
        pool.shutdownNow();
        super.onDestroy();
    }

    private void js(String code) {
        runOnUiThread(() -> web.evaluateJavascript(code, null));
    }

    private void speechEvent(String type, String text) {
        js("window.onSpeech && window.onSpeech(" + JSONObject.quote(type) + "," + JSONObject.quote(text == null ? "" : text) + ")");
    }

    private static String first(Bundle b) {
        if (b == null) return "";
        ArrayList<String> list = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return (list == null || list.isEmpty()) ? "" : list.get(0);
    }

    private void doListen(String lang) {
        if (Build.VERSION.SDK_INT >= 23
                && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 1);
            speechEvent("error", "not-allowed");
            return;
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            speechEvent("error", "unavailable");
            return;
        }
        if (tts != null) tts.stop();
        if (recognizer != null) recognizer.destroy();
        recognizer = SpeechRecognizer.createSpeechRecognizer(this);
        recognizer.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle params) { speechEvent("start", ""); }
            @Override public void onBeginningOfSpeech() {}
            @Override public void onRmsChanged(float rmsdB) {}
            @Override public void onBufferReceived(byte[] buffer) {}
            @Override public void onEndOfSpeech() {}
            @Override public void onError(int error) {
                String code;
                switch (error) {
                    case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: code = "not-allowed"; break;
                    case SpeechRecognizer.ERROR_NO_MATCH:
                    case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: code = "no-speech"; break;
                    case SpeechRecognizer.ERROR_NETWORK:
                    case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: code = "network"; break;
                    default: code = "other-" + error;
                }
                speechEvent("error", code);
            }
            @Override public void onResults(Bundle results) { speechEvent("final", first(results)); }
            @Override public void onPartialResults(Bundle partial) {
                String t = first(partial);
                if (!t.isEmpty()) speechEvent("partial", t);
            }
            @Override public void onEvent(int eventType, Bundle params) {}
        });
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, lang);
        i.putExtra(RecognizerIntent.EXTRA_ONLY_RETURN_LANGUAGE_PREFERENCE, true);
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getPackageName());
        recognizer.startListening(i);
    }

    // ---------- 翻譯 ----------

    private static String readAll(InputStream in) throws Exception {
        BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = r.readLine()) != null) sb.append(line).append('\n');
        r.close();
        return sb.toString();
    }

    private static String google(String text, String sl, String tl) throws Exception {
        String u = "https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=" + sl + "&tl=" + tl
                + "&q=" + URLEncoder.encode(text, "UTF-8");
        HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(15000);
        c.setRequestProperty("User-Agent", "Mozilla/5.0");
        int code = c.getResponseCode();
        if (code != 200) throw new Exception("google-" + code);
        JSONArray parts = new JSONArray(readAll(c.getInputStream())).getJSONArray(0);
        StringBuilder sb = new StringBuilder();
        for (int k = 0; k < parts.length(); k++) {
            JSONArray p = parts.optJSONArray(k);
            if (p != null && !p.isNull(0)) sb.append(p.optString(0));
        }
        return sb.toString();
    }

    private static String claude(String prompt, String key) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL("https://api.anthropic.com/v1/messages").openConnection();
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setConnectTimeout(10000);
        c.setReadTimeout(30000);
        c.setRequestProperty("content-type", "application/json");
        c.setRequestProperty("x-api-key", key);
        c.setRequestProperty("anthropic-version", "2023-06-01");
        JSONObject body = new JSONObject();
        body.put("model", "claude-haiku-5-5");
        body.put("max_tokens", 1024);
        JSONArray msgs = new JSONArray();
        msgs.put(new JSONObject().put("role", "user").put("content", prompt));
        body.put("messages", msgs);
        OutputStream os = c.getOutputStream();
        os.write(body.toString().getBytes(StandardCharsets.UTF_8));
        os.close();
        int code = c.getResponseCode();
        if (code == 401) throw new Exception("badkey");
        if (code == 429) throw new Exception("rate_limited");
        if (code != 200) throw new Exception("claude-" + code);
        JSONArray content = new JSONObject(readAll(c.getInputStream())).getJSONArray("content");
        StringBuilder sb = new StringBuilder();
        for (int k = 0; k < content.length(); k++) {
            JSONObject o = content.getJSONObject(k);
            if ("text".equals(o.optString("type"))) sb.append(o.optString("text"));
        }
        return sb.toString();
    }

    public class Bridge {
        @JavascriptInterface
        public void startListening(String lang) { runOnUiThread(() -> doListen(lang)); }

        @JavascriptInterface
        public void stopListening() { runOnUiThread(() -> { if (recognizer != null) recognizer.stopListening(); }); }

        @JavascriptInterface
        public void cancelListening() { runOnUiThread(() -> { if (recognizer != null) recognizer.cancel(); }); }

        /** 回傳 "ok"、"missing"（沒有該語言語音）或 "notready" */
        @JavascriptInterface
        public String speak(String text, String lang) {
            if (!ttsReady || tts == null) return "notready";
            int r = tts.setLanguage(Locale.forLanguageTag(lang));
            if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) return "missing";
            tts.setSpeechRate(lang.startsWith("vi") ? 0.95f : 1.0f);
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "u" + System.currentTimeMillis());
            return "ok";
        }

        @JavascriptInterface
        public void stopSpeaking() { if (tts != null) tts.stop(); }

        @JavascriptInterface
        public void translate(String id, String text, String sl, String tl, String key, String prompt) {
            pool.execute(() -> {
                String ok, out;
                try {
                    if (key != null && !key.isEmpty()) {
                        try { out = claude(prompt, key); }
                        catch (Exception e) {
                            String m = String.valueOf(e.getMessage());
                            if (m.equals("badkey") || m.equals("rate_limited")) throw e;
                            out = google(text, sl, tl);
                        }
                    } else {
                        out = google(text, sl, tl);
                    }
                    ok = "ok";
                } catch (Exception e) {
                    ok = "error";
                    out = String.valueOf(e.getMessage());
                }
                js("window.onTranslated && window.onTranslated(" + JSONObject.quote(id) + "," + JSONObject.quote(ok) + "," + JSONObject.quote(out) + ")");
            });
        }
    }
}

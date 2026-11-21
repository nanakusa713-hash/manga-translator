package com.wuhen.editor;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.app.RecoverableSecurityException;
import android.content.IntentSender;
import android.provider.DocumentsContract;
import org.json.JSONObject;
import java.io.IOException;
import java.util.Collections;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

public class MainActivity extends Activity {
    private static final int PICK_IMAGE = 1;
    private static final String FOLDER = "無痕修圖";
    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private static final int WRITE_REQ = 3;
    private Uri pickedUri;
    private Uri pendingUri;
    private byte[] pendingBytes;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(0xFF1C1E22);
        getWindow().setNavigationBarColor(0xFF1C1E22);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("image/*");
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                try {
                    startActivityForResult(Intent.createChooser(i, "選擇圖片"), PICK_IMAGE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });
        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl("file:///android_asset/index.html");

        if (Build.VERSION.SDK_INT < 29 && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, 2);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == PICK_IMAGE && fileCallback != null) {
            Uri[] r = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            if (r != null && r.length > 0) {
                pickedUri = r[0];
                try {
                    getContentResolver().takePersistableUriPermission(pickedUri, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                } catch (Exception ignored) {
                }
            }
            fileCallback.onReceiveValue(r);
            fileCallback = null;
        } else if (requestCode == WRITE_REQ) {
            if (resultCode == RESULT_OK && pendingUri != null && pendingBytes != null) {
                try {
                    writeTo(pendingUri, pendingBytes);
                    callJs("ok");
                } catch (Exception e) {
                    callJs("覆蓋失敗：" + e.getMessage());
                }
            } else {
                callJs("已取消覆蓋");
            }
            pendingBytes = null;
            pendingUri = null;
        }
    }

    @Override
    public void onBackPressed() {
        new AlertDialog.Builder(this)
                .setMessage("要離開嗎？尚未儲存的修改會消失。")
                .setPositiveButton("離開", (d, w) -> finish())
                .setNegativeButton("取消", null)
                .show();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    private void writeTo(Uri uri, byte[] bytes) throws IOException {
        try (OutputStream o = getContentResolver().openOutputStream(uri, "wt")) {
            if (o == null) throw new IOException("無法開啟檔案");
            o.write(bytes);
        }
    }

    private void callJs(String result) {
        web.post(() -> web.evaluateJavascript("window.__overwriteDone&&window.__overwriteDone(" + JSONObject.quote(result) + ")", null));
    }

    private void askWrite(IntentSender sender, Uri uri, byte[] bytes) {
        pendingUri = uri;
        pendingBytes = bytes;
        runOnUiThread(() -> {
            try {
                startIntentSenderForResult(sender, WRITE_REQ, null, 0, 0, 0);
            } catch (Exception e) {
                callJs("覆蓋失敗：" + e.getMessage());
            }
        });
    }

    private class Bridge {
        @JavascriptInterface
        public boolean canOverwrite() {
            return pickedUri != null;
        }

        @JavascriptInterface
        public String overwrite(String base64) {
            if (pickedUri == null) return "找不到原檔";
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            try {
                writeTo(pickedUri, bytes);
                return "ok";
            } catch (SecurityException e) {
                try {
                    if (Build.VERSION.SDK_INT >= 30) {
                        Uri media = pickedUri;
                        if (DocumentsContract.isDocumentUri(MainActivity.this, pickedUri)) {
                            media = MediaStore.getMediaUri(MainActivity.this, pickedUri);
                        }
                        if (media != null) {
                            PendingIntent pi = MediaStore.createWriteRequest(getContentResolver(), Collections.singletonList(media));
                            askWrite(pi.getIntentSender(), media, bytes);
                            return "pending";
                        }
                    } else if (Build.VERSION.SDK_INT == 29 && e instanceof RecoverableSecurityException) {
                        askWrite(((RecoverableSecurityException) e).getUserAction().getActionIntent().getIntentSender(), pickedUri, bytes);
                        return "pending";
                    }
                } catch (Exception e2) {
                    return "沒有權限覆蓋這個檔案：" + e2.getMessage();
                }
                return "沒有權限覆蓋這個檔案";
            } catch (Exception e) {
                return "覆蓋失敗：" + e.getMessage();
            }
        }

        @JavascriptInterface
        public String saveImage(String base64, String name, String mime) {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentResolver r = getContentResolver();
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Images.Media.DISPLAY_NAME, name);
                    v.put(MediaStore.Images.Media.MIME_TYPE, mime);
                    v.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/" + FOLDER);
                    Uri uri = r.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) return "無法建立檔案";
                    try (OutputStream o = r.openOutputStream(uri)) {
                        if (o == null) return "無法寫入檔案";
                        o.write(bytes);
                    }
                } else {
                    if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                        runOnUiThread(() -> requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, 2));
                        return "請允許儲存權限後再按一次";
                    }
                    File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), FOLDER);
                    if (!dir.exists() && !dir.mkdirs()) return "無法建立資料夾";
                    File f = new File(dir, name);
                    int n = 1;
                    String base = name.replaceAll("\\.[^.]+$", ""), ext = name.substring(base.length());
                    while (f.exists()) f = new File(dir, base + "(" + (n++) + ")" + ext);
                    try (FileOutputStream o = new FileOutputStream(f)) {
                        o.write(bytes);
                    }
                    MediaScannerConnection.scanFile(MainActivity.this, new String[]{f.getAbsolutePath()}, new String[]{mime}, null);
                }
                return "ok";
            } catch (Exception e) {
                return String.valueOf(e.getMessage());
            }
        }
    }
}

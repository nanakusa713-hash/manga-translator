// 把 App 的 Java 介面包裝成油猴（Tampermonkey）API，讓同一份翻譯腳本可以直接在 App 裡跑
(function () {
  if (window.__mtShim) return;
  window.__mtShim = true;

  var callbacks = {};
  var seq = 0;

  window.__mtXhrDone = function (id) {
    var cb = callbacks[id];
    delete callbacks[id];
    var raw = MTBridge.take(id);
    if (!cb || !raw) return;
    cb(JSON.parse(raw));
  };

  window.GM_getValue = function (key, def) {
    var v = MTBridge.get(String(key));
    if (v === null || v === undefined || v === '') return def;
    try { return JSON.parse(v); } catch (e) { return def; }
  };

  window.GM_setValue = function (key, value) {
    MTBridge.set(String(key), JSON.stringify(value));
  };

  window.GM_registerMenuCommand = function () {};

  window.GM_xmlhttpRequest = function (o) {
    var id = 'x' + (++seq);
    var binary = o.responseType === 'blob';
    callbacks[id] = function (r) {
      if (r.error) {
        if (r.timeout && o.ontimeout) o.ontimeout(r);
        else if (o.onerror) o.onerror(r);
        return;
      }
      var resp = null;
      if (binary && r.status < 400) {
        var bin = atob(r.body);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        resp = new Blob([arr], { type: r.contentType || 'image/jpeg' });
      }
      if (o.onload) {
        o.onload({
          status: r.status,
          responseText: binary ? '' : r.body,
          response: binary ? resp : r.body,
        });
      }
    };
    MTBridge.xhr(
      id,
      o.method || 'GET',
      o.url,
      JSON.stringify(o.headers || {}),
      o.data || '',
      binary,
      o.timeout || 60000
    );
  };
})();

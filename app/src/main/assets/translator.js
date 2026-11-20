// ==UserScript==
// @name         漫畫即時翻譯（Gemini）
// @namespace    manga-translator
// @version      1.0.0
// @description  自動辨識網頁漫畫圖片中的日文／英文，翻成繁體中文並直接疊在對話框上。點右下「譯」開關，長按開設定。
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ---------------- 設定 ---------------- */
  const HOST = location.hostname;
  const DEFAULTS = {
    apiKey: '',
    model: 'gemini-flash-latest',
    targetLang: '繁體中文（台灣用語）',
    minSize: 300,      // 圖片原始寬高至少要這麼大才當成漫畫頁
    concurrency: 2,    // 同時翻譯幾張
  };
  const cfg = Object.assign({}, DEFAULTS, GM_getValue('cfg', {}));
  const saveCfg = () => GM_setValue('cfg', cfg);
  let enabled = GM_getValue('site:' + HOST, false);

  /* ---------------- 快取（翻過的頁面不重翻） ---------------- */
  const CACHE_MAX = 300;
  let cache = GM_getValue('cache', {});
  const cacheGet = (k) => (cache[k] ? cache[k].r : null);
  function cachePut(k, r) {
    cache[k] = { t: Date.now(), r };
    const keys = Object.keys(cache);
    if (keys.length > CACHE_MAX) {
      keys.sort((a, b) => cache[a].t - cache[b].t)
        .slice(0, keys.length - CACHE_MAX)
        .forEach((x) => delete cache[x]);
    }
    GM_setValue('cache', cache);
  }

  /* ---------------- 樣式 ---------------- */
  const style = document.createElement('style');
  style.textContent = `
    #mt-root{position:absolute;top:0;left:0;width:0;height:0;z-index:2147483000;pointer-events:none}
    .mt-layer{position:absolute;pointer-events:none}
    .mt-box{position:absolute;display:flex;align-items:center;justify-content:center;overflow:hidden;
      background:rgba(255,255,255,.96);color:#111;border-radius:6px;pointer-events:auto;
      font-family:"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;font-weight:600;
      box-shadow:0 0 2px rgba(0,0,0,.25);transition:opacity .15s;-webkit-tap-highlight-color:transparent}
    .mt-box.mt-peek{opacity:0}
    .mt-txt{line-height:1.15;text-align:center;word-break:break-word;overflow-wrap:anywhere;max-width:100%;max-height:100%}
    .mt-txt.mt-v{writing-mode:vertical-rl;text-orientation:upright;text-align:start}
    .mt-badge{position:absolute;top:6px;left:6px;padding:3px 8px;border-radius:10px;font:12px/1.4 sans-serif;
      background:rgba(0,0,0,.7);color:#fff;pointer-events:auto;max-width:80%}
    #mt-btn{position:fixed;right:14px;bottom:80px;width:46px;height:46px;border-radius:50%;z-index:2147483001;
      display:none;align-items:center;justify-content:center;font:bold 20px sans-serif;color:#fff;
      background:#888;box-shadow:0 2px 8px rgba(0,0,0,.35);user-select:none;-webkit-user-select:none;
      touch-action:manipulation;-webkit-tap-highlight-color:transparent}
    #mt-btn.on{background:#e8590c}
    #mt-btn .mt-n{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;border-radius:9px;background:#1c7ed6;
      font:bold 11px/18px sans-serif;text-align:center;display:none}
    #mt-panel{position:fixed;inset:0;z-index:2147483002;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center}
    #mt-panel .mt-card{background:#fff;color:#222;width:min(92vw,420px);border-radius:14px;padding:18px;font:15px/1.5 sans-serif}
    #mt-panel h3{margin:0 0 10px;font-size:18px}
    #mt-panel label{display:block;margin:10px 0 4px;font-weight:600}
    #mt-panel input{width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccc;border-radius:8px;font-size:15px;color:#222;background:#fff}
    #mt-panel .mt-row{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
    #mt-panel button{flex:1;padding:10px;border:0;border-radius:8px;font-size:15px;background:#eee;color:#222}
    #mt-panel button.pri{background:#e8590c;color:#fff}
    #mt-panel small{color:#666}
  `;
  document.documentElement.appendChild(style);

  const root = document.createElement('div');
  root.id = 'mt-root';
  document.documentElement.appendChild(root);

  /* ---------------- 浮動按鈕 ---------------- */
  const btn = document.createElement('div');
  btn.id = 'mt-btn';
  btn.innerHTML = '譯<span class="mt-n"></span>';
  document.documentElement.appendChild(btn);
  const btnCount = btn.querySelector('.mt-n');

  let pressTimer = null, longPressed = false;
  btn.addEventListener('pointerdown', () => {
    longPressed = false;
    pressTimer = setTimeout(() => { longPressed = true; openSettings(); }, 600);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) =>
    btn.addEventListener(ev, () => clearTimeout(pressTimer)));
  btn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (longPressed) return;
    setEnabled(!enabled);
  });
  btn.addEventListener('contextmenu', (e) => e.preventDefault());

  function refreshBtn() {
    btn.classList.toggle('on', enabled);
    const pending = [...states.values()].filter((s) => s.status === 'queued' || s.status === 'running').length;
    btnCount.style.display = enabled && pending ? 'block' : 'none';
    btnCount.textContent = pending;
  }

  function setEnabled(v) {
    if (v && !cfg.apiKey) { openSettings(); return; }
    enabled = v;
    GM_setValue('site:' + HOST, v);
    root.style.display = v ? '' : 'none';
    btn.style.display = 'flex';
    if (v) rescanAll();
    refreshBtn();
  }

  GM_registerMenuCommand('漫畫翻譯：設定', () => openSettings());
  GM_registerMenuCommand('漫畫翻譯：在此網站開／關', () => setEnabled(!enabled));

  /* ---------------- 設定面板 ---------------- */
  function openSettings() {
    if (document.getElementById('mt-panel')) return;
    const p = document.createElement('div');
    p.id = 'mt-panel';
    p.innerHTML = `
      <div class="mt-card">
        <h3>漫畫即時翻譯 設定</h3>
        <label>Gemini API 金鑰</label>
        <input id="mt-key" type="password" autocomplete="off" placeholder="貼上 AIza... 開頭的金鑰">
        <small>到 aistudio.google.com 登入 Google 帳號 → Get API key 免費取得</small>
        <label>翻譯成</label>
        <input id="mt-lang">
        <label>模型</label>
        <input id="mt-model">
        <small>預設 gemini-flash-latest；翻得不準可換更強的模型名稱</small>
        <div class="mt-row">
          <button id="mt-clear">清除快取</button>
          <button id="mt-close">取消</button>
          <button id="mt-save" class="pri">儲存</button>
        </div>
      </div>`;
    document.documentElement.appendChild(p);
    const $ = (id) => p.querySelector(id);
    $('#mt-key').value = cfg.apiKey;
    $('#mt-lang').value = cfg.targetLang;
    $('#mt-model').value = cfg.model;
    $('#mt-close').onclick = () => p.remove();
    p.addEventListener('click', (e) => { if (e.target === p) p.remove(); });
    $('#mt-clear').onclick = () => { cache = {}; GM_setValue('cache', {}); $('#mt-clear').textContent = '已清除'; };
    $('#mt-save').onclick = () => {
      const langChanged = cfg.targetLang !== $('#mt-lang').value.trim();
      cfg.apiKey = $('#mt-key').value.trim();
      cfg.targetLang = $('#mt-lang').value.trim() || DEFAULTS.targetLang;
      cfg.model = $('#mt-model').value.trim() || DEFAULTS.model;
      saveCfg();
      p.remove();
      if (langChanged) resetAll();
      if (cfg.apiKey && !enabled) setEnabled(true);
    };
  }

  /* ---------------- 圖片狀態 ---------------- */
  const states = new Map(); // img -> {status, key, layer, badge, fitW}
  const queue = [];
  let running = 0;

  function qualifies(img) {
    if (!img.complete || !img.naturalWidth) return false;
    if (img.naturalWidth < cfg.minSize || img.naturalHeight < cfg.minSize) return false;
    const r = img.getBoundingClientRect();
    return r.width >= Math.min(260, innerWidth * 0.45);
  }

  function consider(img) {
    if (states.has(img)) return;
    if (!img.complete || !img.naturalWidth) {
      img.addEventListener('load', () => { maybeShowBtn(img); if (enabled && isNearView(img)) consider(img); }, { once: true });
      return;
    }
    maybeShowBtn(img);
    if (!enabled || !qualifies(img)) return;
    states.set(img, { status: 'queued' });
    queue.push(img);
    pump();
  }

  function isNearView(img) {
    const r = img.getBoundingClientRect();
    return r.bottom > -1500 && r.top < innerHeight + 1500;
  }

  function pump() {
    refreshBtn();
    while (enabled && running < cfg.concurrency && queue.length) {
      const img = queue.shift();
      const st = states.get(img);
      if (!st || st.status !== 'queued' || !img.isConnected) continue;
      running++;
      st.status = 'running';
      processImg(img, st)
        .then(() => { st.status = 'done'; })
        .catch((err) => { st.status = 'error'; showError(st, img, err); })
        .finally(() => { running--; pump(); });
    }
    refreshBtn();
  }

  function removeState(img) {
    const st = states.get(img);
    if (st && st.layer) st.layer.remove();
    states.delete(img);
  }

  function resetAll() {
    for (const img of [...states.keys()]) removeState(img);
    queue.length = 0;
    rescanAll();
  }

  /* ---------------- 圖片取得與切塊 ---------------- */
  function gmFetchBlob(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'blob', timeout: 30000,
        headers: { Referer: location.href },
        onload: (r) => (r.status >= 200 && r.status < 300 && r.response)
          ? resolve(r.response) : reject(new Error('圖片下載失敗（' + r.status + '）')),
        onerror: () => reject(new Error('圖片下載失敗')),
        ontimeout: () => reject(new Error('圖片下載逾時')),
      });
    });
  }

  async function getImageBlob(img) {
    const src = img.currentSrc || img.src;
    if (/^(blob|data):/.test(src)) return (await fetch(src)).blob();
    try {
      return await gmFetchBlob(src);
    } catch (e) {
      // 備援：同網域圖片直接從畫面上複製
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return await new Promise((res, rej) => {
        try { c.toBlob((b) => (b ? res(b) : rej(e)), 'image/jpeg', 0.9); } catch (_) { rej(e); }
      });
    }
  }

  // 條漫（很長的直條圖）切成多塊，每塊各送一次，座標比較準
  async function blobToChunks(blob) {
    const bmp = await createImageBitmap(blob);
    const W = bmp.width, H = bmp.height;
    const MAX_W = 1280;
    const scale = Math.min(1, MAX_W / W);
    const chunkH = Math.round(W * 2.2);
    const chunks = [];
    for (let y = 0; y < H; y += chunkH) {
      let h = Math.min(chunkH, H - y);
      if (H - (y + h) < W * 0.3) h = H - y; // 剩一小段就併進來
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(W * scale));
      c.height = Math.max(1, Math.round(h * scale));
      c.getContext('2d').drawImage(bmp, 0, y, W, h, 0, 0, c.width, c.height);
      chunks.push({ y0: y / H, y1: (y + h) / H, b64: c.toDataURL('image/jpeg', 0.85).split(',')[1] });
      if (y + h >= H) break;
    }
    if (bmp.close) bmp.close();
    return chunks;
  }

  /* ---------------- Gemini ---------------- */
  function buildPrompt() {
    return [
      '這是一張漫畫圖片，文字可能是日文或英文。',
      '請找出所有對話框、旁白框、手寫台詞等需要翻譯的文字區塊（細小背景字、與劇情無關的浮水印可略過；擬聲詞若明顯就翻）。',
      `把每一塊翻譯成${cfg.targetLang}，語氣自然口語、符合角色說話方式，不要加註解。`,
      '日文直書請依由右至左、由上而下的順序理解；同一個對話框內的文字合併為一筆。',
      '若文字本來就是目標語言，略過。',
      '回傳 JSON 陣列，每筆為 {"box_2d":[ymin,xmin,ymax,xmax],"translation":"譯文"}，座標是 0 到 1000 的正規化值，框住原文所在區域。沒有文字就回傳 []。',
    ].join('\n');
  }

  function gmPostJson(url, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST', url, timeout: 90000,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
        data: JSON.stringify(body),
        onload: (r) => resolve(r),
        onerror: () => reject(new Error('連不上 Gemini')),
        ontimeout: () => reject(new Error('Gemini 回應逾時')),
      });
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function callGemini(b64) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`;
    const body = {
      contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: b64 } }, { text: buildPrompt() }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
              translation: { type: 'STRING' },
            },
            required: ['box_2d', 'translation'],
          },
        },
      },
    };
    for (let attempt = 0; ; attempt++) {
      const r = await gmPostJson(url, body);
      if (r.status === 200) {
        const data = JSON.parse(r.responseText);
        const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
        let txt = parts.map((p) => p.text || '').join('').trim();
        txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
        const arr = JSON.parse(txt || '[]');
        return Array.isArray(arr) ? arr : [];
      }
      if ((r.status === 429 || r.status >= 500) && attempt < 3) {
        await sleep(8000 * (attempt + 1)); // 免費額度每分鐘有上限，等一下再試
        continue;
      }
      let msg = 'Gemini 錯誤 ' + r.status;
      try { msg += '：' + JSON.parse(r.responseText).error.message; } catch (_) { /* ignore */ }
      if (r.status === 400 || r.status === 403) msg += '（請檢查 API 金鑰或模型名稱）';
      throw new Error(msg);
    }
  }

  /* ---------------- 主流程 ---------------- */
  async function processImg(img, st) {
    const src = img.currentSrc || img.src;
    const key = cfg.targetLang + '|' + src;
    st.key = key;
    ensureLayer(st);
    let items = cacheGet(key);
    if (!items) {
      setBadge(st, '翻譯中…');
      const blob = await getImageBlob(img);
      const chunks = await blobToChunks(blob);
      items = [];
      for (let i = 0; i < chunks.length; i++) {
        if (chunks.length > 1) setBadge(st, `翻譯中… ${i + 1}/${chunks.length}`);
        const ch = chunks[i];
        const res = await callGemini(ch.b64);
        for (const it of res) {
          const b = it && it.box_2d;
          const t = String((it && it.translation) || '').trim();
          if (!Array.isArray(b) || b.length !== 4 || !t) continue;
          const [a, b1, c, d] = b.map(Number);
          const ymin = Math.max(0, Math.min(a, c)), ymax = Math.min(1000, Math.max(a, c));
          const xmin = Math.max(0, Math.min(b1, d)), xmax = Math.min(1000, Math.max(b1, d));
          if (ymax - ymin < 5 || xmax - xmin < 5) continue;
          const span = ch.y1 - ch.y0;
          items.push({
            x: xmin / 1000, w: (xmax - xmin) / 1000,
            y: ch.y0 + (ymin / 1000) * span, h: ((ymax - ymin) / 1000) * span,
            t,
          });
        }
      }
      if (st.key !== key || !states.has(img)) return; // 圖片已被換掉
      cachePut(key, items);
    }
    setBadge(st, null);
    renderBoxes(st, items);
    positionAll();
  }

  function ensureLayer(st) {
    if (st.layer) return;
    st.layer = document.createElement('div');
    st.layer.className = 'mt-layer';
    root.appendChild(st.layer);
    st.fitW = 0;
  }

  function setBadge(st, text, onTap) {
    if (!text) { if (st.badge) { st.badge.remove(); st.badge = null; } return; }
    if (!st.badge) {
      st.badge = document.createElement('div');
      st.badge.className = 'mt-badge';
      st.layer.appendChild(st.badge);
    }
    st.badge.textContent = text;
    st.badge.onclick = onTap || null;
    positionAll();
  }

  function showError(st, img, err) {
    console.warn('[漫畫翻譯]', err);
    if (!st.layer) ensureLayer(st);
    setBadge(st, '⚠️ ' + (err && err.message ? err.message : err) + '（點此重試）', (e) => {
      e.stopPropagation();
      setBadge(st, null);
      st.status = 'queued';
      queue.unshift(img);
      pump();
    });
  }

  function renderBoxes(st, items) {
    st.layer.querySelectorAll('.mt-box').forEach((n) => n.remove());
    for (const it of items) {
      // 框稍微放大一點，蓋住原文
      const padX = it.w * 0.08, padY = it.h * 0.06;
      const box = document.createElement('div');
      box.className = 'mt-box';
      box.style.left = ((it.x - padX / 2) * 100) + '%';
      box.style.top = ((it.y - padY / 2) * 100) + '%';
      box.style.width = ((it.w + padX) * 100) + '%';
      box.style.height = ((it.h + padY) * 100) + '%';
      const txt = document.createElement('div');
      txt.className = 'mt-txt';
      txt.textContent = it.t;
      box.appendChild(txt);
      box.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); box.classList.toggle('mt-peek'); });
      st.layer.appendChild(box);
    }
    st.fitW = 0; // 下次定位時重新調整字級
  }

  function fitText(box) {
    const txt = box.firstChild;
    const bw = box.clientWidth, bh = box.clientHeight;
    if (!bw || !bh) return;
    // 細長的直式對話框 → 用直書
    const vertical = bh > bw * 1.6 && /[　-鿿]/.test(txt.textContent);
    txt.classList.toggle('mt-v', vertical);
    let lo = 7, hi = 48, best = 7;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      txt.style.fontSize = mid + 'px';
      if (txt.scrollWidth <= bw && txt.scrollHeight <= bh) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    txt.style.fontSize = best + 'px';
  }

  /* ---------------- 疊圖定位 ---------------- */
  function positionAll() {
    for (const [img, st] of states) {
      if (!st.layer) continue;
      if (!img.isConnected) { removeState(img); continue; }
      const r = img.getBoundingClientRect();
      if (!r.width || !r.height) { st.layer.style.display = 'none'; continue; }
      st.layer.style.display = '';
      st.layer.style.left = (r.left + scrollX) + 'px';
      st.layer.style.top = (r.top + scrollY) + 'px';
      st.layer.style.width = r.width + 'px';
      st.layer.style.height = r.height + 'px';
      if (Math.abs(r.width - st.fitW) > 2) {
        st.fitW = r.width;
        st.layer.querySelectorAll('.mt-box').forEach(fitText);
      }
    }
  }

  let rafPending = false;
  const schedulePosition = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; positionAll(); });
  };
  addEventListener('scroll', schedulePosition, { capture: true, passive: true });
  addEventListener('resize', schedulePosition);
  setInterval(positionAll, 700); // 處理延遲載入造成的版面位移

  /* ---------------- 偵測圖片 ---------------- */
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) consider(en.target);
  }, { rootMargin: '1500px 0px 1500px 0px' });

  const seen = new WeakSet();
  function watchImg(img) {
    if (seen.has(img)) return;
    seen.add(img);
    io.observe(img);
    maybeShowBtn(img);
    // 延遲載入：先放 1x1 佔位圖，之後才換成真的漫畫圖，換好時再檢查一次
    img.addEventListener('load', () => {
      maybeShowBtn(img);
      if (enabled && !states.has(img) && isNearView(img)) consider(img);
    });
  }

  // 保險：定期掃描畫面附近還沒處理的圖片
  setInterval(() => {
    if (!enabled) return;
    document.querySelectorAll('img').forEach((img) => {
      watchImg(img);
      if (!states.has(img) && img.complete && img.naturalWidth && isNearView(img)) consider(img);
    });
  }, 1500);

  function maybeShowBtn(img) {
    if (btn.style.display === 'flex') return;
    if (enabled || (img.complete && img.naturalWidth >= cfg.minSize && img.naturalHeight >= cfg.minSize && qualifies(img))) {
      btn.style.display = 'flex';
      refreshBtn();
    }
  }

  function rescanAll() {
    document.querySelectorAll('img').forEach((img) => {
      watchImg(img);
      io.unobserve(img);
      io.observe(img);
    });
  }

  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') {
        const img = m.target;
        if (img.tagName === 'IMG' && states.has(img)) {
          removeState(img); // 閱讀器換頁：同一個 <img> 換了圖
          const retry = () => { if (enabled && isNearView(img)) consider(img); };
          if (img.complete) retry(); else img.addEventListener('load', retry, { once: true });
          refreshBtn();
        }
        continue;
      }
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'IMG') watchImg(n);
        else if (n.querySelectorAll) n.querySelectorAll('img').forEach(watchImg);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'] });

  // 給 App 版的工具列按鈕呼叫
  window.__mtOpenSettings = openSettings;
  window.__mtToggle = () => setEnabled(!enabled);

  root.style.display = enabled ? '' : 'none';
  rescanAll();
  if (enabled) btn.style.display = 'flex';
  refreshBtn();
})();

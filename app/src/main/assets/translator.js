// ==UserScript==
// @name         漫畫即時翻譯（Gemini）
// @namespace    manga-translator
// @version      1.2.0
// @description  自動辨識網頁漫畫圖片中的日文／英文，翻成繁體中文並直接疊在對話框上。滑到哪翻到哪。點右下「譯」開關，長按開設定。
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

  const VERSION = '1.2';

  /* ---------------- 設定 ---------------- */
  const HOST = location.hostname;
  const DEFAULTS = {
    apiKey: '',
    model: 'gemini-flash-latest',
    targetLang: '繁體中文（台灣用語）',
    minSize: 300,      // 圖片原始寬高至少要這麼大才當成漫畫頁
    concurrency: 2,    // 同時翻譯幾段
    thinkIdx: 0,       // 降低 AI 思考量的參數，會自動找出模型接受的寫法
  };
  const cfg = Object.assign({}, DEFAULTS, GM_getValue('cfg', {}));
  const saveCfg = () => GM_setValue('cfg', cfg);
  let enabled = GM_getValue('site:' + HOST, false);

  // 長條圖以「寬 × 這個倍數」的高度切段，一段大約一個多螢幕
  const CHUNK_RATIO = 2.0;
  // 段落進入「畫面上方 300px 到下方 1200px」範圍才開始翻
  const AHEAD_PX = 1200, BEHIND_PX = 300;

  /* ---------------- 快取（翻過的段落不重翻） ---------------- */
  const CACHE_MAX = 600;
  let cache = GM_getValue('cache2', {});
  const cacheGet = (k) => (cache[k] ? cache[k].r : null);
  let cacheSaveTimer = null;
  function cachePut(k, r) {
    cache[k] = { t: Date.now(), r };
    const keys = Object.keys(cache);
    if (keys.length > CACHE_MAX) {
      keys.sort((a, b) => cache[a].t - cache[b].t)
        .slice(0, keys.length - CACHE_MAX)
        .forEach((x) => delete cache[x]);
    }
    clearTimeout(cacheSaveTimer);
    cacheSaveTimer = setTimeout(() => GM_setValue('cache2', cache), 1000);
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
    .mt-badge{position:absolute;left:6px;padding:3px 8px;border-radius:10px;font:12px/1.4 sans-serif;
      background:rgba(0,0,0,.7);color:#fff;pointer-events:auto;max-width:85%;white-space:normal}
    #mt-btn{position:fixed;right:14px;bottom:80px;width:46px;height:46px;border-radius:50%;z-index:2147483001;
      display:none;align-items:center;justify-content:center;font:bold 20px sans-serif;color:#fff;
      background:#888;box-shadow:0 2px 8px rgba(0,0,0,.35);user-select:none;-webkit-user-select:none;
      touch-action:manipulation;-webkit-tap-highlight-color:transparent}
    #mt-btn.on{background:#e8590c}
    #mt-btn .mt-n{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;border-radius:9px;background:#1c7ed6;
      font:bold 11px/18px sans-serif;text-align:center;display:none;padding:0 3px;box-sizing:border-box}
    #mt-tip{position:fixed;right:68px;bottom:90px;z-index:2147483001;padding:4px 10px;border-radius:12px;
      background:rgba(0,0,0,.75);color:#fff;font:13px/1.4 sans-serif;display:none;pointer-events:none;max-width:60vw}
    #mt-panel{position:fixed;inset:0;z-index:2147483002;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center}
    #mt-panel .mt-card{background:#fff;color:#222;width:min(92vw,420px);max-height:90vh;overflow:auto;border-radius:14px;padding:18px;font:15px/1.5 sans-serif;box-sizing:border-box}
    #mt-panel h3{margin:0 0 10px;font-size:18px}
    #mt-panel label{display:block;margin:10px 0 4px;font-weight:600}
    #mt-panel input{width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccc;border-radius:8px;font-size:15px;color:#222;background:#fff}
    #mt-panel .mt-row{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
    #mt-panel button{flex:1;padding:10px;border:0;border-radius:8px;font-size:15px;background:#eee;color:#222}
    #mt-panel button.pri{background:#e8590c;color:#fff}
    #mt-panel small{color:#666}
    #mt-diag{white-space:pre-wrap;font:12px/1.4 monospace;background:#f4f4f4;color:#222;padding:8px;border-radius:8px;max-height:30vh;overflow:auto;margin:0}
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

  const tip = document.createElement('div');
  tip.id = 'mt-tip';
  document.documentElement.appendChild(tip);
  let tipTimer = null;
  function showTip(text, ms) {
    tip.textContent = text;
    tip.style.display = 'block';
    clearTimeout(tipTimer);
    if (ms) tipTimer = setTimeout(() => { tip.style.display = 'none'; }, ms);
  }

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

  function chunkCounts() {
    const c = { idle: 0, queued: 0, running: 0, done: 0, error: 0 };
    for (const st of states.values()) for (const ch of st.chunks) c[ch.status]++;
    return c;
  }

  let wasBusy = false;
  function refreshBtn() {
    btn.classList.toggle('on', enabled);
    const c = chunkCounts();
    const busy = c.queued + c.running;
    btnCount.style.display = enabled && busy ? 'block' : 'none';
    btnCount.textContent = busy;
    if (enabled && c.running) showTip('翻譯中…', 0);
    else if (wasBusy && !busy) showTip(c.error ? '有 ' + c.error + ' 段失敗，點圖上的 ⚠️ 重試' : '這段翻好了', 1500);
    else if (!busy) tip.style.display = 'none';
    wasBusy = !!busy;
  }

  function setEnabled(v) {
    if (v && !cfg.apiKey) { openSettings(); return; }
    enabled = v;
    GM_setValue('site:' + HOST, v);
    root.style.display = v ? '' : 'none';
    btn.style.display = 'flex';
    if (v) { showTip('翻譯已開啟', 1200); sweep(); } else showTip('翻譯已關閉', 1200);
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
        <label>診斷資訊</label>
        <pre id="mt-diag"></pre>
        <div class="mt-row">
          <button id="mt-clear">清除快取</button>
          <button id="mt-close">取消</button>
          <button id="mt-save" class="pri">儲存</button>
        </div>
      </div>`;
    document.documentElement.appendChild(p);
    const $ = (id) => p.querySelector(id);
    $('#mt-diag').textContent = diagnose();
    $('#mt-key').value = cfg.apiKey;
    $('#mt-lang').value = cfg.targetLang;
    $('#mt-model').value = cfg.model;
    $('#mt-close').onclick = () => p.remove();
    p.addEventListener('click', (e) => { if (e.target === p) p.remove(); });
    $('#mt-clear').onclick = () => { cache = {}; GM_setValue('cache2', {}); $('#mt-clear').textContent = '已清除'; };
    $('#mt-save').onclick = () => {
      const newLang = $('#mt-lang').value.trim() || DEFAULTS.targetLang;
      const newModel = $('#mt-model').value.trim() || DEFAULTS.model;
      const changed = cfg.targetLang !== newLang || cfg.model !== newModel;
      if (cfg.model !== newModel) cfg.thinkIdx = 0;
      cfg.apiKey = $('#mt-key').value.trim();
      cfg.targetLang = newLang;
      cfg.model = newModel;
      saveCfg();
      p.remove();
      if (changed) resetAll();
      if (cfg.apiKey && !enabled) setEnabled(true);
      else sweep();
    };
  }

  /* ---------------- 診斷 ---------------- */
  let lastErr = '';
  function diagnose() {
    const imgs = [...document.querySelectorAll('img')];
    const big = imgs.filter((i) => i.naturalWidth >= cfg.minSize && i.naturalHeight >= cfg.minSize);
    const c = chunkCounts();
    const lines = [
      '版本：' + VERSION + '　網站：' + HOST + '　開啟：' + (enabled ? '是' : '否'),
      '圖片總數：' + imgs.length + '　大圖：' + big.length + '　處理中圖片：' + states.size,
      '段落：待命 ' + c.idle + '／排隊 ' + c.queued + '／翻譯中 ' + c.running + '／完成 ' + c.done + '／錯誤 ' + c.error,
      'iframe：' + document.querySelectorAll('iframe').length + '　canvas：' + document.querySelectorAll('canvas').length
        + '　視窗寬：' + innerWidth + '　思考參數：' + cfg.thinkIdx,
      '最近錯誤：' + (lastErr || '無'),
      '— 畫面附近的圖片 —',
    ];
    imgs.filter(isNearView).slice(0, 6).forEach((i) => {
      const r = i.getBoundingClientRect();
      const src = (i.currentSrc || i.src || '').slice(0, 70);
      const st = states.get(i);
      lines.push(i.naturalWidth + 'x' + i.naturalHeight + ' 顯示' + Math.round(r.width) + 'x' + Math.round(r.height)
        + (i.complete ? '' : ' 未載完')
        + (st ? ' [' + st.chunks.map((ch) => ch.status[0]).join('') + ']' : '') + '\n  ' + src);
    });
    return lines.join('\n');
  }

  /* ---------------- 圖片與段落狀態 ---------------- */
  // img -> { src, layer, fitW, blobP, chunks:[{i,y0,y1,status,badge}] }
  const states = new Map();
  const jobs = [];   // { img, st, ch }
  let running = 0;

  function qualifies(img) {
    if (!img.complete || !img.naturalWidth) return false;
    if (img.naturalWidth < cfg.minSize || img.naturalHeight < cfg.minSize) return false;
    const r = img.getBoundingClientRect();
    return r.width >= Math.min(260, innerWidth * 0.45);
  }

  function isNearView(img) {
    const r = img.getBoundingClientRect();
    return r.bottom > -1500 && r.top < innerHeight + 1500;
  }

  function planChunks(W, H) {
    const chunkH = Math.round(W * CHUNK_RATIO);
    const out = [];
    for (let y = 0, i = 0; y < H; i++) {
      let h = Math.min(chunkH, H - y);
      if (H - (y + h) < W * 0.4) h = H - y; // 剩一小段就併進來
      out.push({ i, y0: y / H, y1: (y + h) / H, status: 'idle', badge: null });
      y += h;
    }
    return out;
  }

  const cacheKey = (st, ch) => cfg.targetLang + '|' + cfg.model + '|' + st.src + '|' + ch.i + '/' + st.chunks.length;

  // 開始追蹤一張漫畫圖
  function track(img) {
    if (states.has(img) || !enabled || !qualifies(img)) return;
    const st = {
      src: img.currentSrc || img.src,
      layer: null, fitW: 0, blobP: null,
      chunks: planChunks(img.naturalWidth, img.naturalHeight),
    };
    states.set(img, st);
    ensureLayer(st);
    for (const ch of st.chunks) {
      const hit = cacheGet(cacheKey(st, ch));
      if (hit) { ch.status = 'done'; renderChunk(st, ch, hit); }
    }
    positionAll();
  }

  // 把畫面附近、還沒翻的段落排進佇列
  function schedule() {
    if (!enabled) return;
    for (const [img, st] of states) {
      if (!img.isConnected) continue;
      const r = img.getBoundingClientRect();
      if (!r.height) continue;
      for (const ch of st.chunks) {
        if (ch.status !== 'idle') continue;
        const top = r.top + ch.y0 * r.height, bot = r.top + ch.y1 * r.height;
        if (bot > -BEHIND_PX && top < innerHeight + AHEAD_PX) {
          ch.status = 'queued';
          jobs.push({ img, st, ch });
        }
      }
    }
    pump();
  }

  // 離畫面越近的段落越先翻
  function jobDistance(job) {
    const r = job.img.getBoundingClientRect();
    const top = r.top + job.ch.y0 * r.height, bot = r.top + job.ch.y1 * r.height;
    if (bot < 0) return -bot + 200;        // 已經滑過去的，稍後
    if (top > innerHeight) return top - innerHeight;
    return 0;                               // 正在看的
  }

  function pump() {
    while (enabled && running < cfg.concurrency && jobs.length) {
      let best = 0, bestD = Infinity;
      for (let k = 0; k < jobs.length; k++) {
        const d = jobDistance(jobs[k]);
        if (d < bestD) { bestD = d; best = k; }
      }
      const job = jobs.splice(best, 1)[0];
      if (states.get(job.img) !== job.st || job.ch.status !== 'queued' || !job.img.isConnected) continue;
      running++;
      job.ch.status = 'running';
      setChunkBadge(job.st, job.ch, '翻譯中…');
      runChunk(job)
        .then(() => { job.ch.status = 'done'; setChunkBadge(job.st, job.ch, null); })
        .catch((err) => { job.ch.status = 'error'; showChunkError(job, err); })
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
    jobs.length = 0;
    sweep();
  }

  /* ---------------- 圖片取得與裁切 ---------------- */
  function gmFetchBlob(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'blob', timeout: 45000,
        headers: { Referer: location.href },
        onload: (r) => (r.status >= 200 && r.status < 300 && r.response)
          ? resolve(r.response) : reject(new Error('圖片下載失敗（' + r.status + '）')),
        onerror: () => reject(new Error('圖片下載失敗')),
        ontimeout: () => reject(new Error('圖片下載逾時')),
      });
    });
  }

  async function getImageBlob(img, src) {
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

  async function cropChunk(blob, img, ch) {
    const W = img.naturalWidth, H = img.naturalHeight;
    const sy = Math.round(ch.y0 * H), sh = Math.max(1, Math.round((ch.y1 - ch.y0) * H));
    const scale = Math.min(1, 1024 / W);
    const outW = Math.max(1, Math.round(W * scale)), outH = Math.max(1, Math.round(sh * scale));
    let bmp;
    try {
      bmp = await createImageBitmap(blob, 0, sy, W, sh, { resizeWidth: outW, resizeHeight: outH, resizeQuality: 'high' });
    } catch (e) {
      bmp = await createImageBitmap(blob, 0, sy, W, sh);
    }
    const c = document.createElement('canvas');
    c.width = outW; c.height = outH;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, outW, outH);
    g.drawImage(bmp, 0, 0, outW, outH);
    if (bmp.close) bmp.close();
    return c.toDataURL('image/jpeg', 0.85).split(',')[1];
  }

  /* ---------------- Gemini ---------------- */
  function buildPrompt() {
    return [
      '這是一段漫畫圖片（可能是長條漫畫的一部分），文字可能是日文、英文或韓文。',
      '請找出所有對話框、旁白框、手寫台詞等需要翻譯的文字區塊（細小背景字、浮水印可略過；明顯的擬聲詞可以翻）。',
      `把每一塊翻譯成${cfg.targetLang}，語氣自然口語、符合角色說話方式，不要加註解。`,
      '日文直書請依由右至左、由上而下的順序理解；同一個對話框內的文字合併為一筆。',
      '若文字本來就是目標語言，略過。被圖片上下邊緣切掉一半的文字也略過。',
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

  // 依序嘗試：最少思考 → 低思考 → 關閉思考 → 不指定
  const THINK_OPTIONS = [{ thinkingLevel: 'minimal' }, { thinkingLevel: 'low' }, { thinkingBudget: 0 }, null];

  async function callGemini(b64) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`;
    let waits = 0;
    for (;;) {
      const think = THINK_OPTIONS[Math.min(cfg.thinkIdx, THINK_OPTIONS.length - 1)];
      const generationConfig = {
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
      };
      if (think) generationConfig.thinkingConfig = think;
      const body = {
        contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: b64 } }, { text: buildPrompt() }] }],
        generationConfig,
      };
      const r = await gmPostJson(url, body);
      if (r.status === 200) {
        const data = JSON.parse(r.responseText);
        const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
        let txt = parts.filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
        txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
        const arr = JSON.parse(txt || '[]');
        return Array.isArray(arr) ? arr : [];
      }
      let msg = '';
      try { msg = JSON.parse(r.responseText).error.message || ''; } catch (_) { /* ignore */ }
      // 模型不接受這種思考參數 → 換下一種
      if (r.status === 400 && /think/i.test(msg) && cfg.thinkIdx < THINK_OPTIONS.length - 1) {
        cfg.thinkIdx++;
        saveCfg();
        continue;
      }
      if ((r.status === 429 || r.status >= 500) && waits < 4) {
        waits++;
        showTip('免費額度用得太快，等一下自動重試…', 0);
        await sleep(10000 * waits);
        continue;
      }
      let out = 'Gemini 錯誤 ' + r.status + (msg ? '：' + msg : '');
      if (r.status === 400 || r.status === 403) out += '（請檢查 API 金鑰或模型名稱）';
      if (r.status === 429) out = '免費額度暫時用完了，過幾分鐘再點此重試';
      throw new Error(out);
    }
  }

  /* ---------------- 翻譯一段 ---------------- */
  async function runChunk({ img, st, ch }) {
    const key = cacheKey(st, ch);
    if (!st.blobP) {
      st.blobP = getImageBlob(img, st.src);
      st.blobP.catch(() => { st.blobP = null; }); // 失敗下次重抓
    }
    const blob = await st.blobP;
    const b64 = await cropChunk(blob, img, ch);
    const res = await callGemini(b64);
    const span = ch.y1 - ch.y0;
    const items = [];
    for (const it of res) {
      const b = it && it.box_2d;
      const t = String((it && it.translation) || '').trim();
      if (!Array.isArray(b) || b.length !== 4 || !t) continue;
      const [a, b1, c, d] = b.map(Number);
      const ymin = Math.max(0, Math.min(a, c)), ymax = Math.min(1000, Math.max(a, c));
      const xmin = Math.max(0, Math.min(b1, d)), xmax = Math.min(1000, Math.max(b1, d));
      if (ymax - ymin < 3 || xmax - xmin < 5) continue;
      items.push({
        x: xmin / 1000, w: (xmax - xmin) / 1000,
        y: ch.y0 + (ymin / 1000) * span, h: ((ymax - ymin) / 1000) * span,
        t,
      });
    }
    if (states.get(img) !== st) return; // 圖片已被換掉
    cachePut(key, items);
    renderChunk(st, ch, items);
    positionAll();
  }

  /* ---------------- 畫面呈現 ---------------- */
  function ensureLayer(st) {
    if (st.layer) return;
    st.layer = document.createElement('div');
    st.layer.className = 'mt-layer';
    root.appendChild(st.layer);
    st.fitW = 0;
  }

  function setChunkBadge(st, ch, text, onTap) {
    if (!text) { if (ch.badge) { ch.badge.remove(); ch.badge = null; } return; }
    if (!ch.badge) {
      ch.badge = document.createElement('div');
      ch.badge.className = 'mt-badge';
      ch.badge.style.top = 'calc(' + (ch.y0 * 100) + '% + 6px)';
      st.layer.appendChild(ch.badge);
    }
    ch.badge.textContent = text;
    ch.badge.onclick = onTap || null;
  }

  function showChunkError(job, err) {
    const msg = String(err && err.message ? err.message : err);
    console.warn('[漫畫翻譯]', err);
    lastErr = msg;
    setChunkBadge(job.st, job.ch, '⚠️ ' + msg + '（點此重試）', (e) => {
      e.stopPropagation();
      setChunkBadge(job.st, job.ch, null);
      job.ch.status = 'idle';
      schedule();
    });
  }

  function renderChunk(st, ch, items) {
    st.layer.querySelectorAll('.mt-box[data-c="' + ch.i + '"]').forEach((n) => n.remove());
    for (const it of items) {
      // 框稍微放大一點，蓋住原文
      const padX = it.w * 0.08, padY = it.h * 0.08;
      const box = document.createElement('div');
      box.className = 'mt-box';
      box.dataset.c = ch.i;
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
      if (st.layer.clientWidth) fitText(box);
    }
  }

  function fitText(box) {
    const txt = box.firstChild;
    const bw = box.clientWidth, bh = box.clientHeight;
    if (!bw || !bh) return;
    // 細長的直式對話框 → 用直書
    const vertical = bh > bw * 1.6 && /[　-鿿]/.test(txt.textContent);
    txt.classList.toggle('mt-v', vertical);
    let lo = 7, hi = 40, best = 7;
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

  let rafPending = false, lastSchedule = 0;
  const onScroll = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      positionAll();
      const now = Date.now();
      if (now - lastSchedule > 400) { lastSchedule = now; schedule(); }
    });
  };
  addEventListener('scroll', onScroll, { capture: true, passive: true });
  addEventListener('resize', onScroll);

  /* ---------------- 偵測圖片 ---------------- */
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { track(en.target); schedule(); }
  }, { rootMargin: '1500px 0px 1500px 0px' });

  const seen = new WeakSet();
  function watchImg(img) {
    if (seen.has(img)) return;
    seen.add(img);
    io.observe(img);
    maybeShowBtn(img);
    // 延遲載入：先放佔位圖，之後才換成真的漫畫圖，換好時再檢查一次
    img.addEventListener('load', () => {
      maybeShowBtn(img);
      if (enabled && !states.has(img) && isNearView(img)) { track(img); schedule(); }
    });
  }

  function maybeShowBtn(img) {
    if (btn.style.display === 'flex') return;
    if (enabled || qualifies(img)) {
      btn.style.display = 'flex';
      refreshBtn();
    }
  }

  // 定期掃描：補抓新圖片、更新位置、排程翻譯
  function sweep() {
    document.querySelectorAll('img').forEach((img) => {
      watchImg(img);
      if (enabled && !states.has(img) && isNearView(img)) track(img);
    });
    positionAll();
    schedule();
  }
  setInterval(sweep, 1500);

  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') {
        const img = m.target;
        if (img.tagName === 'IMG' && states.has(img) && states.get(img).src !== (img.currentSrc || img.src)) {
          removeState(img); // 閱讀器換頁：同一個 <img> 換了圖
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
  if (enabled) btn.style.display = 'flex';
  sweep();
  refreshBtn();
})();

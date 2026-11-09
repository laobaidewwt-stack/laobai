// 老白笔记 · 海报（作品库与剧单）
// 列表用第一张做封面，点开看全部；编辑弹层里加图、调顺序、换封面、删除。改动立即保存。
// 只调用 ledger_poster_* 四个交互入口；不碰作品、剧单、字幕和交付的保存流程。
const RPC = /^ledger_poster_(sets|get|add|arrange)$/;
const KINDS = new Set(['work', 'pick']);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const MAX_PER_TARGET = 12;
const FULL_EDGE = 1280, FULL_BYTES = 560000;
const THUMB_EDGE = 360, THUMB_BYTES = 110000;
const POLL_MS = 20000;
const CACHE_MAX_BYTES = 64 * 1024 * 1024, CACHE_MAX_AGE = 30 * 86400000;
const MESSAGES = {
  POSTER_LIMIT: '每部最多 12 张海报',
  POSTER_TOO_LARGE: '图片太大，压缩后仍超过上限',
  POSTER_INVALID_IMAGE: '这张图片格式不对，没有保存',
  POSTER_QUOTA: '海报空间已满，请先删掉一些旧海报（或让 GPT 调高上限）',
  POSTER_VERSION_CONFLICT: '另一台设备刚改过这组海报，已载入最新顺序，请再操作一次',
  POSTER_ID_CONFLICT: '图片编号冲突，请重新选择这张图片',
  POSTER_NOT_FOUND: '这张海报已被删除',
  read_only: '当前为只读，没有保存海报改动'
};

class PosterError extends Error { constructor(code, message, uncertain = false) { super(message); this.code = code; this.uncertain = uncertain; } }

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64 = async blob => { const u8 = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (data, mime) => { const s = atob(data), u8 = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); return new Blob([u8], { type: mime }); };

// 可丢弃的本机图片缓存，不是备份。最多 64MiB / 30 天，收到新顺序时清掉已移除的图。
// v2 清空旧版无时间戳缓存；仅影响本机可重新下载的副本，不修改云端图片。
function openCache() {
  let dbp = null;
  const db = () => dbp ||= new Promise(resolve => {
    try {
      const req = indexedDB.open('laobai-posters', 2);
      req.onupgradeneeded = () => {
        if (req.result.objectStoreNames.contains('img')) req.result.deleteObjectStore('img');
        req.result.createObjectStore('img');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  const tx = async (mode, fn) => {
    const d = await db(); if (!d) return null;
    return new Promise(resolve => { try {
      const t = d.transaction('img', mode), r = fn(t.objectStore('img'));
      t.oncomplete = () => resolve(r?.result ?? null);
      t.onerror = t.onabort = () => resolve(null);
    } catch { resolve(null); } });
  };
  async function prune(active = null) {
    const d = await db(); if (!d) return;
    return new Promise(resolve => { try {
      const t = d.transaction('img', 'readwrite'), st = t.objectStore('img'), rows = [], req = st.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (c) { rows.push({ key: c.key, value: c.value }); c.continue(); return; }
        const keep = selectPosterCacheKeys(rows, active);
        for (const r of rows) if (!keep.has(r.key)) st.delete(r.key);
      };
      t.oncomplete = t.onabort = t.onerror = () => resolve();
    } catch { resolve(); } });
  }
  return {
    async get(key) {
      const v = await tx('readonly', s => s.get(key));
      return v?.blob instanceof Blob && Number.isFinite(v.at) && Date.now() - v.at < CACHE_MAX_AGE ? v.blob : null;
    },
    async put(key, blob) {
      if (blob.size > CACHE_MAX_BYTES) return;
      await tx('readwrite', s => s.put({ blob, at: Date.now() }, key));
      await prune();
    },
    prune,
  };
}

// Pure retention rule for independent tests. Newest cached entries win the byte budget.
export function selectPosterCacheKeys(rows, active = null, now = Date.now()) {
  const valid = rows.filter(r => typeof r.key === 'string' && r.value?.blob instanceof Blob &&
    Number.isFinite(r.value.at) && now - r.value.at < CACHE_MAX_AGE && r.value.at <= now &&
    (!active || active.has(r.key.slice(0, r.key.lastIndexOf(':')))));
  valid.sort((a, b) => b.value.at - a.value.at || String(a.key).localeCompare(String(b.key)));
  const keep = new Set(); let used = 0;
  for (const r of valid) if (used + r.value.blob.size <= CACHE_MAX_BYTES) { keep.add(r.key); used += r.value.blob.size; }
  return keep;
}

// 选图 → 读出 → 缩到两种尺寸 → 压缩。优先 WebP，浏览器不会编码 WebP 时用 JPEG。
async function decodeImage(file) {
  if (file.size > 40 * 1024 * 1024) throw new PosterError('too_big', '原图超过 40MB，请换一张');
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {}
  const url = URL.createObjectURL(file);
  try { const im = new Image(); im.decoding = 'async'; im.src = url; await im.decode(); return im; }
  catch { throw new PosterError('decode', '这张图片读不出来，请换一张'); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
function drawTo(src, edge) {
  const w0 = src.naturalWidth || src.width, h0 = src.naturalHeight || src.height;
  const k = Math.min(1, edge / Math.max(w0, h0)), w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(src, 0, 0, w, h);
  return c;
}
const toBlob = (c, type, q) => new Promise(r => c.toBlob(b => r(b), type, q));
let webpOk = null;
async function pickMime() {
  if (webpOk === null) { const c = document.createElement('canvas'); c.width = c.height = 2; const b = await toBlob(c, 'image/webp', 0.8); webpOk = !!b && b.type === 'image/webp'; }
  return webpOk ? 'image/webp' : 'image/jpeg';
}
async function encodeUnder(src, edge, maxBytes, mime) {
  for (let e = edge; e >= 240; e = Math.round(e * 0.8)) {
    const c = drawTo(src, e);
    for (const q of [0.84, 0.74, 0.64, 0.54]) {
      const b = await toBlob(c, mime, q);
      if (b && b.type === mime && b.size <= maxBytes) return { blob: b, width: c.width, height: c.height };
    }
  }
  throw new PosterError('POSTER_TOO_LARGE', MESSAGES.POSTER_TOO_LARGE);
}
export async function preparePoster(file) {
  const src = await decodeImage(file), mime = await pickMime();
  try {
    const full = await encodeUnder(src, FULL_EDGE, FULL_BYTES, mime);
    const thumb = await encodeUnder(src, THUMB_EDGE, THUMB_BYTES, mime);
    return { mime, width: full.width, height: full.height, full: full.blob, thumb: thumb.blob };
  } finally { try { src.close?.(); } catch {} }
}

export function createPosterUI({ getCloud: rawCloud, fetcher = fetch, canWrite: rawCanWrite = () => true, toast = () => {}, titleOf = () => '' }) {
  // 页面初始化早期，这些值可能还没定义；取不到就当作「还没连上」。
  const getCloud = () => { try { return rawCloud(); } catch { return null; } };
  const canWrite = () => { try { return !!rawCanWrite(); } catch { return false; } };
  const sets = new Map();            // 'work:id' → {ids:[], version}
  const urls = new Map();            // 'imgId:size' → objectURL
  const loading = new Map();         // 'imgId:size' → Promise<url>
  const roots = new Map();           // kind → 列表容器（最近一次渲染）
  const cache = openCache();
  let unavailable = null; // 云端还没装海报功能时，十分钟内不再询问（换钥匙后立即重试）
  const off = () => !!unavailable && unavailable.key === stateKey && Date.now() - unavailable.at < 600000;
  let etag = null, stateKey = '', polling = null, refreshing = null, editor = null, viewer = null, queue = 0;
  const waiters = [];

  const k = (kind, id) => kind + ':' + id;
  const setOf = (kind, id) => sets.get(k(kind, id)) || { ids: [], version: 0 };

  async function rpc(name, args, timeoutMs = 20000, expectedKey = null) {
    if (!RPC.test(name)) throw new PosterError('forbidden', '不允许访问此接口');
    const cloud = getCloud(), key = cloud?.key;
    if (expectedKey !== null && key !== expectedKey) throw new PosterError('cancelled', '钥匙已变化，未上传原草稿');
    if (!key) throw new PosterError('bad_key', '请先输入原账本钥匙');
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
    let r;
    try {
      r = await fetcher(cloud.url + '/rest/v1/rpc/' + name, { method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: ctl.signal, headers: { 'Content-Type': 'application/json', apikey: cloud.anon }, body: JSON.stringify({ p_key: key, ...args }) });
    } catch (e) {
      if (e?.code === 'read_only') throw new PosterError('read_only', MESSAGES.read_only);
      throw new PosterError('network', '网络没有连上', true);
    } finally { clearTimeout(timer); }
    let body; try { body = await r.json(); } catch { throw new PosterError('response', '服务器响应无法读取', !r.ok || r.status >= 500); }
    if (getCloud()?.key !== key) throw new PosterError('cancelled', '钥匙已变化');
    if (!r.ok) {
      const msg = String(body?.message || ''), code = (msg.match(/POSTER_[A-Z_]+/) || [])[0] || (/bad key/i.test(msg) ? 'bad_key' : body?.code || String(r.status));
      throw new PosterError(code, MESSAGES[code] || (code === 'bad_key' ? '钥匙已失效' : code === '42501' ? '海报保存已暂停，看图不受影响' : '海报没有保存：' + (msg || r.status)), r.status >= 500);
    }
    return body;
  }

  function resetIfKeyChanged() {
    const key = getCloud()?.key || '';
    if (key !== stateKey) { releaseDraft(editor); editor = null; stateKey = key; sets.clear(); etag = null; }
  }

  // 安全候选不发起自动永久清理。删除作品后保留云端海报，后续另行人工核对。
  function pruneLocalCopies() {
    const active = new Set([...sets.values()].flatMap(s => s.ids));
    for (const [key, url] of urls) if (!active.has(key.slice(0, key.lastIndexOf(':')))) {
      URL.revokeObjectURL(url); urls.delete(key);
    }
    void cache.prune(active);
  }

  function applySets(list) {
    sets.clear();
    for (const s of list || []) if (KINDS.has(s.kind) && ID_RE.test(s.ownerId) && Array.isArray(s.ids)) sets.set(k(s.kind, s.ownerId), { ids: s.ids.slice(0, MAX_PER_TARGET), version: +s.version || 0 });
  }
  function applyOne(set) {
    if (!set || !KINDS.has(set.kind)) return;
    sets.set(k(set.kind, set.ownerId), { ids: set.ids || [], version: +set.version || 0 });
    pruneLocalCopies();
    etag = null; // 下一轮重新对齐整体 etag
  }

  async function refresh() {
    resetIfKeyChanged();
    if (!getCloud()?.key || off()) return false;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const r = await rpc('ledger_poster_sets', etag ? { p_etag: etag } : {}, 15000);
        if (r?.protocol !== 'ledger_poster_v1') return false;
        if (r.changed) { applySets(r.sets); etag = r.etag; pruneLocalCopies(); redraw(); return true; }
        etag = r.etag; return false;
      } catch (e) { if (e.code === 'PGRST202' || e.code === '404') { unavailable = { key: stateKey, at: Date.now() }; redraw(); } return false; }
      finally { refreshing = null; }
    })();
    return refreshing;
  }
  function start() {
    if (polling) return;
    polling = setInterval(() => { if (!document.hidden) void refresh(); }, POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
    void refresh();
  }
  function stop() { clearInterval(polling); polling = null; document.removeEventListener('visibilitychange', onVisible); }
  function onVisible() { if (!document.hidden) void refresh(); }

  async function slot() { if (queue < 4) { queue++; return; } await new Promise(r => waiters.push(r)); queue++; }
  function release() { queue--; const w = waiters.shift(); if (w) w(); }
  function imageURL(id, size) {
    const key = id + ':' + size;
    if (urls.has(key)) return Promise.resolve(urls.get(key));
    if (loading.has(key)) return loading.get(key);
    const p = (async () => {
      let blob = await cache.get(key);
      if (!(blob instanceof Blob)) {
        await slot();
        try { const r = await rpc('ledger_poster_get', { p_id: id, p_size: size }, 30000); blob = fromB64(r.data, r.mime); }
        finally { release(); }
        void cache.put(key, blob);
      }
      const u = URL.createObjectURL(blob); urls.set(key, u); return u;
    })();
    loading.set(key, p); p.finally(() => loading.delete(key)).catch(() => {});
    return p;
  }
  function remember(id, size, blob) { const key = id + ':' + size; if (!urls.has(key)) urls.set(key, URL.createObjectURL(blob)); void cache.put(key, blob); }

  // —— 列表封面 ——
  function cards(kind, root) {
    if (!root) return [];
    if (kind === 'work') return [...root.querySelectorAll('.work[data-search-id]')].map(el => [el, el.dataset.searchId]);
    return [...root.querySelectorAll('.pw[data-search-id] > .paper.pk')].map(el => [el, el.parentElement.dataset.searchId]);
  }
  function coverHTML(kind, id, n) {
    return '<button type="button" class="pst-cover" data-pst-open="' + kind + '" data-pst-id="' + esc(id) + '" aria-label="看海报（共 ' + n + ' 张）"><span class="pst-mount"><img alt="" decoding="async" draggable="false"></span>' + (n > 1 ? '<span class="pst-count">✦ ' + n + '</span>' : '') + '</button>';
  }
  function decorate(kind, root) {
    resetIfKeyChanged(); roots.set(kind, root); start();
    if (etag === null && !refreshing && getCloud()?.key) void refresh();
    for (const [el, id] of cards(kind, root)) {
      const s = setOf(kind, id), old = el.querySelector(':scope > .pst-cover');
      if (!s.ids.length) { if (old) old.remove(); el.classList.remove('has-cover'); continue; }
      if (old && old.dataset.pstFirst === s.ids[0] && old.dataset.pstN === String(s.ids.length)) continue;
      if (old) old.remove();
      const t = document.createElement('template'); t.innerHTML = coverHTML(kind, id, s.ids.length);
      const node = t.content.firstElementChild; node.dataset.pstFirst = s.ids[0]; node.dataset.pstN = String(s.ids.length);
      if (kind === 'work') el.prepend(node); else el.insertBefore(node, el.querySelector(':scope > .pk-title') || el.firstChild);
      el.classList.add('has-cover');
      const img = node.querySelector('img'), first = s.ids[0];
      imageURL(first, 'thumb').then(u => { if (img.isConnected && node.dataset.pstFirst === first) { img.src = u; img.onload = () => node.classList.add('ready'); } }).catch(() => node.classList.add('failed'));
    }
  }
  function redraw() {
    for (const [kind, root] of roots) if (root?.isConnected) decorate(kind, root);
    if (editor?.host?.isConnected) renderEditor();
    if (viewer && !viewer.el.hidden) syncViewer();
  }

  // —— 看大图 ——
  function ensureViewer() {
    if (viewer) return viewer;
    const el = document.createElement('div');
    el.className = 'pst-viewer'; el.hidden = true; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', '海报');
    el.innerHTML = '<div class="pst-v-top"><span class="pst-v-title"></span><button type="button" class="pst-v-btn" data-pst-v="close" aria-label="关闭">✕</button></div>' +
      '<div class="pst-v-stage"><button type="button" class="pst-v-btn pst-v-prev" data-pst-v="prev" aria-label="上一张">‹</button><figure class="pst-v-mat"><img alt="" draggable="false"></figure><button type="button" class="pst-v-btn pst-v-next" data-pst-v="next" aria-label="下一张">›</button></div>' +
      '<div class="pst-v-foot"><span class="pst-v-index"></span><span class="pst-v-dots"></span></div>';
    document.body.appendChild(el);
    viewer = { el, kind: '', id: '', i: 0, x0: null };
    el.addEventListener('click', e => {
      if (viewer.swiped) { viewer.swiped = false; return; }
      const a = e.target.closest('[data-pst-v]')?.dataset.pstV;
      if (a === 'close' || e.target === el || e.target.classList.contains('pst-v-stage')) closeViewer();
      else if (a === 'prev') step(-1); else if (a === 'next') step(1);
      else if (e.target.closest('[data-pst-dot]')) { viewer.i = +e.target.closest('[data-pst-dot]').dataset.pstDot; syncViewer(); }
    });
    // 左右滑动换图：手指用 touch 事件，鼠标和笔用 pointer 事件，互不重复。
    const swipeStart = (x, y) => { viewer.x0 = x; viewer.y0 = y; viewer.swiped = false; };
    const swipeEnd = (x, y) => { if (viewer.x0 == null) return; const dx = x - viewer.x0, dy = y - viewer.y0; viewer.x0 = null; if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.4) { viewer.swiped = true; step(dx < 0 ? 1 : -1); } };
    el.addEventListener('touchstart', e => { if (e.touches.length === 1) swipeStart(e.touches[0].clientX, e.touches[0].clientY); else viewer.x0 = null; }, { passive: true });
    el.addEventListener('touchend', e => { const t = e.changedTouches[0]; if (t) swipeEnd(t.clientX, t.clientY); });
    el.addEventListener('pointerdown', e => { if (e.pointerType !== 'touch') swipeStart(e.clientX, e.clientY); });
    el.addEventListener('pointerup', e => { if (e.pointerType !== 'touch') swipeEnd(e.clientX, e.clientY); });
    el.addEventListener('dragstart', e => e.preventDefault());
    document.addEventListener('keydown', e => { if (el.hidden) return; if (e.key === 'Escape') closeViewer(); else if (e.key === 'ArrowLeft') step(-1); else if (e.key === 'ArrowRight') step(1); });
    return viewer;
  }
  function openViewer(kind, id, i = 0) {
    const v = ensureViewer(), s = setOf(kind, id); if (!s.ids.length) return;
    v.kind = kind; v.id = id; v.i = Math.max(0, Math.min(i, s.ids.length - 1)); v.back = document.activeElement;
    v.el.hidden = false; document.documentElement.classList.add('pst-viewing'); syncViewer(); v.el.querySelector('[data-pst-v="close"]').focus({ preventScroll: true });
  }
  function closeViewer() { if (!viewer || viewer.el.hidden) return; viewer.el.hidden = true; document.documentElement.classList.remove('pst-viewing'); try { viewer.back?.focus?.({ preventScroll: true }); } catch {} }
  function step(d) { const s = setOf(viewer.kind, viewer.id); if (s.ids.length < 2) return; viewer.i = (viewer.i + d + s.ids.length) % s.ids.length; syncViewer(); }
  function syncViewer() {
    const v = viewer, s = setOf(v.kind, v.id);
    if (!s.ids.length) return closeViewer();
    v.i = Math.min(v.i, s.ids.length - 1);
    const id = s.ids[v.i], img = v.el.querySelector('.pst-v-mat img'), mat = v.el.querySelector('.pst-v-mat');
    v.el.querySelector('.pst-v-title').textContent = '《' + (titleOf(v.kind, v.id) || '未命名') + '》' + (v.i === 0 ? ' · 封面' : '');
    v.el.querySelector('.pst-v-index').textContent = (v.i + 1) + ' / ' + s.ids.length;
    v.el.querySelector('.pst-v-dots').innerHTML = s.ids.length > 1 ? s.ids.map((_, n) => '<button type="button" data-pst-dot="' + n + '" aria-label="第 ' + (n + 1) + ' 张"' + (n === v.i ? ' aria-current="true"' : '') + '></button>').join('') : '';
    v.el.querySelectorAll('.pst-v-prev,.pst-v-next').forEach(b => b.hidden = s.ids.length < 2);
    mat.classList.remove('ready'); img.removeAttribute('src'); img.dataset.id = id;
    const show = u => { if (img.dataset.id === id) { img.src = u; img.onload = () => mat.classList.add('ready'); } };
    if (urls.has(id + ':thumb')) show(urls.get(id + ':thumb'));
    imageURL(id, 'full').then(show).catch(() => imageURL(id, 'thumb').then(show).catch(() => { if (img.dataset.id === id) mat.classList.add('failed'); }));
  }

  // —— 编辑弹层里的海报区 ——
  function mountEditor(kind, id, host) {
    if (!host) return;
    resetIfKeyChanged(); start();
    releaseDraft(editor);
    editor = { key: stateKey, pending: [], draftSel: 0, kind, id: id && ID_RE.test(id) ? id : null, host, sel: 0, busy: false, armDelete: false, msg: '' };
    host.hidden = false; renderEditor(); void refresh();
  }
  function renderEditor() {
    const ed = editor, h = ed.host, writable = canWrite();
    if (off()) {
      h.innerHTML = '<div class="pst-ed-head"><span class="pst-ed-name">海报</span><span class="pst-ed-note">云端还没开通海报功能，其他照常使用</span></div>';
      return;
    }
    if (!ed.id || ed.pending.length) {
      const savedCount = setOf(ed.kind, ed.id).ids.length;
      ed.draftSel = Math.min(ed.draftSel, Math.max(0, ed.pending.length - 1));
      const firstIsCover = savedCount === 0;
      const items = ed.pending.map((x,i) => '<button type="button" class="pst-thumb pst-draft ready'+(i===ed.draftSel?' on':'')+'" data-pst-ed="draft-pick" data-i="'+i+'" aria-label="待上传第 '+(i+1)+' 张'+(i===0&&firstIsCover?'（封面）':'')+'" aria-pressed="'+(i===ed.draftSel)+'" '+(ed.busy?'disabled':'')+'><span class="pst-mount"><img alt="待上传海报" draggable="false" src="'+x.url+'"></span>'+(i===0&&firstIsCover?'<span class="pst-ribbon">封面</span>':'')+'</button>').join('');
      const draftTools = ed.pending.length && writable ? '<div class="pst-tools pst-draft-tools">'+
        (firstIsCover?'<button type="button" class="chip" data-pst-ed="draft-cover" '+(ed.busy||ed.draftSel===0?'disabled':'')+'>设为封面</button>':'')+
        '<button type="button" class="chip" data-pst-ed="draft-left" aria-label="往前移" '+(ed.busy||ed.draftSel===0?'disabled':'')+'>‹ 前移</button>'+
        '<button type="button" class="chip" data-pst-ed="draft-right" aria-label="往后移" '+(ed.busy||ed.draftSel>=ed.pending.length-1?'disabled':'')+'>后移 ›</button>'+
        '<button type="button" class="chip" data-pst-ed="draft-remove" '+(ed.busy?'disabled':'')+'>移除</button></div>' : '';
      h.innerHTML = '<div class="pst-ed-head"><span class="pst-ed-name">海报 · 选填</span><span class="pst-ed-note">'+(ed.id?'剧已保存；未上传的海报可重试，不会重复创建剧':'可以不加；选好后点下方保存，先存剧再上传海报')+'</span></div><div class="pst-strip">'+items+(writable&&savedCount+ed.pending.length<MAX_PER_TARGET?'<label class="pst-add"><input type="file" accept="image/*" multiple data-pst-ed="file" '+(ed.busy?'disabled':'')+'><span>＋</span><small>加海报</small></label>':'')+'</div>'+draftTools+(ed.pending.length?'<p class="pst-ed-note">点选海报后可前移、后移'+(firstIsCover?'或设为封面，第一张为封面':'；待上传图片排在已保存海报后面')+'。保存时按此顺序上传。</p>':'')+(ed.id&&writable?'<button type="button" class="chip" data-pst-ed="retry" '+(ed.busy?'disabled':'')+'>重试未上传海报</button>':'')+'<p class="pst-ed-note">海报不含在账本备份中，请保留原图。</p><p class="pst-msg" role="status">'+esc(ed.msg)+'</p>';
      h.querySelector('.pst-draft.on')?.scrollIntoView?.({block:'nearest',inline:'nearest'});
      return;
    }
    const s = setOf(ed.kind, ed.id); ed.sel = Math.min(ed.sel, Math.max(0, s.ids.length - 1));
    const thumbs = s.ids.map((pid, i) => '<button type="button" class="pst-thumb' + (i === ed.sel ? ' on' : '') + '" data-pst-ed="pick" data-i="' + i + '" aria-label="第 ' + (i + 1) + ' 张' + (i === 0 ? '（封面）' : '') + '" aria-pressed="' + (i === ed.sel) + '"><span class="pst-mount"><img alt="" draggable="false" data-pst-img="' + esc(pid) + '"></span>' + (i === 0 ? '<span class="pst-ribbon">封面</span>' : '') + '</button>').join('');
    const add = writable && s.ids.length < MAX_PER_TARGET ? '<label class="pst-add' + (ed.busy ? ' busy' : '') + '"><input type="file" accept="image/*" multiple data-pst-ed="file"' + (ed.busy ? ' disabled' : '') + '><span>＋</span><small>加海报</small></label>' : '';
    const tools = s.ids.length ? '<div class="pst-tools">' +
      '<button type="button" class="chip" data-pst-ed="view">看大图</button>' +
      (writable ? '<button type="button" class="chip" data-pst-ed="cover"' + (ed.sel === 0 || ed.busy ? ' disabled' : '') + '>设为封面</button>' +
      '<button type="button" class="chip" data-pst-ed="left" aria-label="往前移"' + (ed.sel === 0 || ed.busy ? ' disabled' : '') + '>‹ 前移</button>' +
      '<button type="button" class="chip" data-pst-ed="right" aria-label="往后移"' + (ed.sel >= s.ids.length - 1 || ed.busy ? ' disabled' : '') + '>后移 ›</button>' +
      '<button type="button" class="chip pst-del' + (ed.armDelete ? ' armed' : '') + '" data-pst-ed="del"' + (ed.busy ? ' disabled' : '') + '>' + (ed.armDelete ? '再点永久删除' : '删除') + '</button>' : '') + '</div>' : '';
    const note = !writable ? '当前为只读，只能看' : s.ids.length ? '第一张是封面 · 改动即时保存，不用点下面的保存' : '可以不放；放了以后，列表用第一张做封面';
    h.innerHTML = '<div class="pst-ed-head"><span class="pst-ed-name">海报</span><span class="pst-ed-note">' + note + '</span></div>' +
      '<div class="pst-strip">' + thumbs + add + '</div><p class="pst-ed-note">海报不含在账本备份中，请保留原图。</p>' + tools + '<p class="pst-msg" role="status">' + esc(ed.msg) + '</p>';
    h.querySelectorAll('img[data-pst-img]').forEach(img => { const pid = img.dataset.pstImg; imageURL(pid, 'thumb').then(u => { if (img.isConnected) { img.src = u; img.onload = () => img.closest('.pst-thumb')?.classList.add('ready'); } }).catch(() => {}); });
  }
  function say(msg) { if (!editor) return; editor.msg = msg; const p = editor.host.querySelector('.pst-msg'); if (p) p.textContent = msg; }

  function releaseDraft(ed) { if (ed) for (const x of ed.pending) URL.revokeObjectURL(x.url); }
  function stage(files, ed = editor) {
    if (!ed || ed.busy || !canWrite()) return;
    const room = Math.max(0, MAX_PER_TARGET - setOf(ed.kind, ed.id).ids.length - ed.pending.length);
    for (const file of [...files].slice(0,room)) {
      if (file.size > 40*1024*1024) { toast('原图超过 40MB，请换一张'); continue; }
      ed.pending.push({id:crypto.randomUUID(),file,url:URL.createObjectURL(file)});
    }
    if (files.length>room) toast('每部最多 12 张');
    renderEditor();
  }
  async function commitDraft(kind, id, ticket) {
    if (!ticket || ticket !== editor || ticket.kind !== kind) return true;
    if (ticket.busy) return false;
    if (ticket.key !== getCloud()?.key) return false;
    ticket.id = id;
    return ticket.pending.length ? upload([], ticket) : true;
  }
  async function upload(files = [], target = editor) {
    const ed = target; if (!ed?.id || ed.busy || ed.key !== getCloud()?.key) return false;
    if (!canWrite()) return toast(MESSAGES.read_only);
    const { kind, id } = ed;
    const confirmed = new Set(setOf(kind, id).ids);
    ed.pending = ed.pending.filter(item => { if (!confirmed.has(item.id)) return true; URL.revokeObjectURL(item.url); return false; });
    stage(files, ed); const list = ed.pending.slice(); let lastUsage = null;
    const room = MAX_PER_TARGET - setOf(kind, id).ids.length;
    if (list.length > room) toast('每部最多 12 张，这次只加前 ' + Math.max(0, room) + ' 张');
    ed.busy = true; ed.armDelete = false; renderEditor();
    let added = 0, skipped = '';
    try {
      for (const [n, item] of list.slice(0, Math.max(0, room)).entries()) {
        say('正在处理第 ' + (n + 1) + ' / ' + Math.min(list.length, room) + ' 张…');
        let prepared;
        try { prepared = item.prepared ||= await preparePoster(item.file); } catch (e) { skipped = e.message || '这张图片读不出来，请换一张'; toast(skipped); continue; }
        const pid = item.id;
        const args = { p_kind: kind, p_owner_id: id, p_id: pid, p_mime: prepared.mime, p_width: prepared.width, p_height: prepared.height, p_thumb: await b64(prepared.thumb), p_full: await b64(prepared.full) };
        // 同一编号重发是安全的：服务器认出内容相同就原样返回，不会多加一张。
        let r = null, lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { r = await rpc('ledger_poster_add', args, 45000, ed.key); break; }
          catch (e) { lastErr = e; if (!e.uncertain) break; await sleep(800 * (attempt + 1)); }
        }
        if (!r && lastErr?.uncertain) { await refresh(); if (setOf(kind, id).ids.includes(pid)) r = { set: null }; }
        if (!r) throw lastErr;
        if (ed.key !== getCloud()?.key) return false;
        ed.pending = ed.pending.filter(x => x !== item); URL.revokeObjectURL(item.url);
        remember(pid, 'thumb', prepared.thumb); remember(pid, 'full', prepared.full);
        if (r.set) applyOne(r.set); added++;
        if (r.usage?.maxBytes) lastUsage = r.usage;
        if (editor === ed) ed.sel = Math.max(0, setOf(kind, id).ids.indexOf(pid));
        redraw();
      }
      const pct = lastUsage ? Math.round(lastUsage.usedBytes / lastUsage.maxBytes * 100) : 0;
      say((added ? '已保存 ' + added + ' 张' + (pct >= 80 ? '。海报空间已用 ' + pct + '%' : '') : '') + (skipped ? (added ? '；' : '') + skipped : ''));
    } catch (e) {
      say(e.message); toast(e.message); void refresh();
    } finally { ed.busy = false; if (editor === ed) renderEditor(); redraw(); }
    return ed.pending.length === 0;
  }

  async function arrange(next, done) {
    const ed = editor; if (!ed?.id || ed.busy) return;
    if (!canWrite()) return toast(MESSAGES.read_only);
    const { kind, id } = ed, cur = setOf(kind, id);
    ed.busy = true; ed.armDelete = false; renderEditor();
    try {
      const r = await rpc('ledger_poster_arrange', { p_kind: kind, p_owner_id: id, p_ids: next, p_expected_version: cur.version });
      applyOne(r.set); say(done);
    } catch (e) {
      if (e.code === 'POSTER_VERSION_CONFLICT' || e.uncertain) {
        await refresh(); const now = setOf(kind, id).ids;
        if (now.length === next.length && now.every((x, i) => x === next[i])) say(done);
        else { const m = e.code === 'POSTER_VERSION_CONFLICT' ? MESSAGES.POSTER_VERSION_CONFLICT : '没能确认是否保存，已载入最新顺序'; say(m); toast(m); }
      } else { say(e.message); toast(e.message); }
    } finally { ed.busy = false; redraw(); }
  }

  document.addEventListener('click', e => {
    const open = e.target.closest('[data-pst-open]');
    if (open) { e.preventDefault(); openViewer(open.dataset.pstOpen, open.dataset.pstId, 0); return; }
    const b = e.target.closest('[data-pst-ed]'); if (!b || !editor || !editor.host.contains(b)) return;
    const ed = editor, s = setOf(ed.kind, ed.id), ids = s.ids.slice(), i = ed.sel, act = b.dataset.pstEd;
    if (act === 'file') return;
    if (ed.busy) return;
    e.preventDefault();
    if (act !== 'del') ed.armDelete = false;
    if (act === 'draft-pick') { ed.draftSel = +b.dataset.i; renderEditor(); }
    else if (act.startsWith('draft-')) {
      if (!canWrite()) return toast(MESSAGES.read_only);
      const n = ed.draftSel, list = ed.pending;
      if (act === 'draft-remove') { const x = list.splice(n,1)[0]; if(x) URL.revokeObjectURL(x.url); ed.draftSel = Math.max(0,n-1); }
      else if (act === 'draft-left' && n > 0) { [list[n-1],list[n]]=[list[n],list[n-1]]; ed.draftSel=n-1; }
      else if (act === 'draft-right' && n < list.length-1) { [list[n+1],list[n]]=[list[n],list[n+1]]; ed.draftSel=n+1; }
      else if (act === 'draft-cover' && n > 0 && !s.ids.length) { list.unshift(list.splice(n,1)[0]); ed.draftSel=0; }
      renderEditor();
    }
    else if (act === 'retry') void upload();
    else if (act === 'pick') { ed.sel = +b.dataset.i; renderEditor(); }
    else if (act === 'view') openViewer(ed.kind, ed.id, i);
    else if (act === 'cover' && i > 0) { ids.unshift(ids.splice(i, 1)[0]); ed.sel = 0; void arrange(ids, '已换成封面'); }
    else if (act === 'left' && i > 0) { [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]]; ed.sel = i - 1; void arrange(ids, i - 1 === 0 ? '已换成封面' : '已调整顺序'); }
    else if (act === 'right' && i < ids.length - 1) { [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]]; ed.sel = i + 1; void arrange(ids, '已调整顺序'); }
    else if (act === 'del') {
      if (!ed.armDelete) { ed.armDelete = true; renderEditor(); setTimeout(() => { if (editor === ed && ed.armDelete) { ed.armDelete = false; renderEditor(); } }, 4000); return; }
      ids.splice(i, 1); ed.sel = Math.max(0, i - 1); void arrange(ids, '已删除');
    }
  });
  document.addEventListener('change', e => {
    const input = e.target.closest?.('[data-pst-ed="file"]'); if (!input || !editor?.host.contains(input)) return;
    const files = [...(input.files || [])]; input.value = ''; if (files.length) { if (!editor.id) stage(files); else void upload(files); }
  });

  return {
    decorate, mountEditor, refresh, openViewer, commitDraft,
    captureDraft(kind) { return editor?.kind === kind ? editor : null; },
    isBusy() { return !!editor?.busy; },
    unmountEditor() { if (editor) { releaseDraft(editor); editor.host.hidden = true; editor.host.innerHTML = ''; editor = null; } },
    clear() { releaseDraft(editor); editor=null; stop(); sets.clear(); etag = null; stateKey = ''; closeViewer(); for (const url of urls.values()) URL.revokeObjectURL(url); urls.clear(); for (const r of roots.values()) r?.querySelectorAll?.('.pst-cover').forEach(n => n.remove()); },
    _state: () => ({ sets: [...sets.entries()], etag }),
  };
}


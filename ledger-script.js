/* Display-only Chinese script preference. Original records, input values and exports stay untouched. */
(() => {
  'use strict';
  const KEY = 'ledger_script', sources = new WeakMap(), attrs = new WeakMap();
  let mode = 'hans';
  try { if (localStorage.getItem(KEY) === 'hant') mode = 'hant'; } catch (_) {}
  const cc = window.OpenCC;
  if (!cc) return; // The ledger remains usable even if the optional dictionary failed to load.
  const converters = {
    hans: cc.ConverterFactory(cc.Locale.to.cn),
    hant: cc.ConverterFactory(cc.Locale.from.cn)
  };
  const skip = 'script,style,textarea,input,code,pre,[contenteditable],[data-script-original]';
  const attrSkip = 'script,style,code,pre,[contenteditable],[data-script-original]';
  function convert(text) {
    // Never convert literal URLs, mail addresses or machine identifiers embedded in prose.
    return String(text).split(/((?:https?:\/\/|mailto:|www\.)[^\s<>]+|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)
      .map((part,i) => i % 2 ? part : converters[mode](part)).join('');
  }
  function original(node) {
    if (node.nodeType === 3) {
      const entry = sources.get(node);
      return entry && node.data === entry.shown ? entry.raw : node.data;
    }
    return Array.from(node.childNodes || [], original).join('');
  }
  function eligible(el) {
    return el && !el.closest(skip) && !(el.closest('option') && !el.closest('option').hasAttribute('value'));
  }
  function text(node) {
    if (!eligible(node.parentElement)) return;
    const raw = original(node), shown = convert(raw);
    sources.set(node, {raw, shown});
    if (node.data !== shown) node.data = shown;
  }
  function attributes(el) {
    // Form hints are presentation, unlike input values and textarea contents.
    if (!el || el.closest(attrSkip)) return;
    let saved = attrs.get(el);
    if (!saved) attrs.set(el, saved = {});
    for (const name of ['title','aria-label','placeholder']) {
      if (!el.hasAttribute(name)) continue;
      const value = el.getAttribute(name), last = saved[name];
      const raw = last && value === last.shown ? last.raw : value, shown = convert(raw);
      saved[name] = {raw, shown};
      if (value !== shown) el.setAttribute(name, shown);
    }
  }
  function walk(root) {
    if (root.nodeType === 3) return text(root);
    if (root.nodeType !== 1) return;
    attributes(root);
    if (root.closest(skip)) return;
    for (const child of root.childNodes) walk(child);
  }
  let observer;
  function update(roots) {
    if (!window.document || !document.body) return;
    observer.disconnect();
    try {
      roots.forEach(root => { if (root.isConnected) walk(root); });
      document.documentElement.lang = mode === 'hant' ? 'zh-Hant' : 'zh-Hans';
      document.querySelectorAll('[data-script-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.scriptMode === mode)));
    } finally {
      observer.observe(document.body, {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['title','aria-label','placeholder']});
    }
  }
  function setMode(value) {
    if (!['hans','hant'].includes(value)) return;
    mode = value;
    try { localStorage.setItem(KEY, mode); } catch (_) {}
    update([document.body]);
  }
  window.LedgerScript = Object.freeze({ originalText: original, get mode(){return mode;} });
  function start() {
    observer = new MutationObserver(records => {
      const roots = new Set();
      records.forEach(r => {
        if (r.type === 'childList') r.addedNodes.forEach(n => roots.add(n));
        else roots.add(r.target);
      });
      update([...roots]);
    });
    document.addEventListener('click', e => {
      const button = e.target.closest('[data-script-mode]');
      if (button) setMode(button.dataset.scriptMode);
    });
    update([document.body]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true});
  else start();
})();


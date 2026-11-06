/* Home-screen UI only. Cloud requests, authentication and record writes stay in ledger.html. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const entry = $('installEntry');
  const dialog = $('installDialog');
  if (!entry || !dialog) return;
  const displayMode = window.matchMedia('(display-mode: standalone)');
  const isStandalone = () => displayMode.matches || navigator.standalone === true;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let installEvent = null;
  let prompting = false;
  const tabs = [...dialog.querySelectorAll('[data-install-platform]')];
  const syncMode = () => { entry.hidden = isStandalone(); };
  const syncNetwork = () => { $('appOffline').hidden = navigator.onLine !== false; };
  function selectPlatform(platform) {
    tabs.forEach(tab => tab.setAttribute('aria-pressed', String(tab.dataset.installPlatform === platform)));
    $('installIOS').hidden = platform !== 'ios';
    $('installAndroid').hidden = platform !== 'android';
  }
  function closeGuide() {
    if (typeof dialog.close === 'function') dialog.close();
    else { dialog.removeAttribute('open'); dialog.hidden = true; }
    entry.focus();
  }
  entry.addEventListener('click', () => {
    if (dialog.open) return;
    selectPlatform(isIOS ? 'ios' : 'android');
    $('installStatus').textContent = '';
    $('installNow').hidden = !installEvent;
    dialog.hidden = false;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    $('installClose').focus();
  });
  $('installClose').addEventListener('click', closeGuide);
  dialog.addEventListener('click', event => { if (event.target === dialog) closeGuide(); });
  dialog.addEventListener('close', () => { dialog.hidden = true; entry.focus(); });
  tabs.forEach(tab => tab.addEventListener('click', () => selectPlatform(tab.dataset.installPlatform)));
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installEvent = event;
    $('installNow').hidden = false;
  });
  $('installNow').addEventListener('click', async () => {
    if (!installEvent || prompting) return;
    prompting = true;
    const event = installEvent;
    installEvent = null;
    $('installNow').disabled = true;
    try {
      await event.prompt();
      const choice = await event.userChoice;
      $('installStatus').textContent = choice.outcome === 'accepted'
        ? '已发送安装请求。完成后，从主屏幕点「老白笔记」打开。'
        : '还没有安装。想装的时候，也可以按上面的步骤从浏览器菜单添加。';
    } catch (_) {
      $('installStatus').textContent = '这次未能打开安装窗口，请按上面的步骤从浏览器菜单添加。';
    } finally {
      prompting = false;
      $('installNow').disabled = false;
      $('installNow').hidden = !installEvent;
    }
  });
  window.addEventListener('appinstalled', () => {
    installEvent = null;
    $('installNow').hidden = true;
    entry.hidden = true;
    $('installStatus').textContent = '已安装，可以从主屏幕打开「老白笔记」了。';
  });
  if (displayMode.addEventListener) displayMode.addEventListener('change', syncMode);
  window.addEventListener('online', syncNetwork);
  window.addEventListener('offline', syncNetwork);
  syncMode();
  syncNetwork();
  // Only static shell assets are cached. RPC requests and credentials are never cached.
  // No forced reload or skipWaiting: an update must not interrupt an unfinished edit.
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('./ledger-sw.js', { scope: './', updateViaCache: 'none' }).catch(() => {
      // A browser that blocks service workers can still open the ledger and add a shortcut.
    });
  }
})();

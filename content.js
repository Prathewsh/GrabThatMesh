// WORLD: MAIN — runs in the page context with direct access to window
// run_at: document_start — before any page JavaScript
(function() {
  'use strict';

  // One cache entry per document prevents other tabs and reloads sharing models.
  if (window.__meshyDLSession) return;
  const sessionId = crypto.randomUUID();
  window.__meshyDLSession = sessionId;
  const state = { glb: null, textures: [], modelName: '', status: 'idle', pageUrl: location.href };

  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url, opts) {
      super(url, opts);
      if (!String(url).includes('loader-worker')) return;
      // An independent listener preserves native onmessage, handleEvent and removal.
      this.addEventListener('message', event => {
        try { tryIntercept(event.data); }
        catch (error) { console.warn('[GrabThatMesh] Capture failed:', error); }
      });
    }
  };

  function checkNavigation() {
    if (state.pageUrl === location.href) return;
    state.pageUrl = location.href;
    state.glb = null;
    state.textures = [];
    state.modelName = '';
    state.status = 'idle';
    persist();
    updateBtn();
  }
  setInterval(checkNavigation, 500);

  // ── Intercept message data ──────────────────────────────────────────────────
  function buffersAreEqual(a, b) {
    if (!a || !b || a.byteLength !== b.byteLength) return false;
    const u1 = new Uint8Array(a);
    const u2 = new Uint8Array(b);
    for (let i = 0; i < u1.length; i++) {
      if (u1[i] !== u2[i]) return false;
    }
    return true;
  }

  function tryIntercept(data) {
    if (!data || data.type !== 'process' || !data.success) return;
    checkNavigation();
    const input = data.data;
    const buf = ArrayBuffer.isView(input)
      ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
      : input;
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < 12) return;

    const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
    const header = new DataView(buf);
    if (magic !== 'glTF' || header.getUint32(4, true) !== 2 || header.getUint32(8, true) !== buf.byteLength) {
      console.log('[GrabThatMesh] Invalid GLB header');
      return;
    }

    const newGlb = buf.slice(0);
    if (state.glb && buffersAreEqual(state.glb, newGlb)) return;

    if (state.glb) {
      console.log('[GrabThatMesh] 🔄 New model detected; resetting textures');
      state.textures = [];
    }

    state.glb = newGlb;
    state.modelName = getModelName();
    state.status = 'ready';
    console.log('[GrabThatMesh] ✅ GLB captured!', (buf.byteLength/1024/1024).toFixed(2), 'MB');

    persist();
    updateBtn();
  }

  // ── Patch fetch to capture textures ──────────────────────────────────────────
  const _fetch = window.fetch;
  window.fetch = async function(...args) {
    checkNavigation();
    const pageUrl = state.pageUrl;
    const resp = await _fetch.apply(this, args);
    try {
      const input = args[0];
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (resp.ok && url.hostname === 'assets.meshy.ai' && /\.png$/i.test(url.pathname)) {
        resp.clone().arrayBuffer().then(buf => {
          checkNavigation();
          if (state.pageUrl !== pageUrl) return;
          const name = url.pathname.split('/').pop();
          if (!state.textures.some(t => t.name === name)) {
            state.textures.push({ name, buf });
            persist();
            updateBtn();
          }
        }).catch(() => {});
      }
    } catch (error) {
      // Capture must never reject an otherwise successful page request.
      console.warn('[GrabThatMesh] Texture capture failed:', error);
    }
    return resp;
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  function getModelName() {
    const h1 = document.querySelector('h1');
    if (h1?.textContent) return h1.textContent.trim().replace(/[^\w\-. ]/g, '_').trim() || 'model';
    return document.title.split('|')[0].trim().replace(/[^\w\-. ]/g, '_') || 'model';
  }

  // ── IndexedDB ──────────────────────────────────────────────────────────────
  let dbPromise;
  function openDB() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open('meshy_dl', 2);
      let failed = false;
      const fail = error => { failed = true; clearTimeout(timer); reject(error); };
      const timer = setTimeout(() => fail(new Error('Storage is not responding.')), 5000);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        const db = request.result;
        if (failed) { db.close(); return; }
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      request.onerror = () => fail(request.error);
      request.onblocked = () => fail(new Error('Storage is blocked. Close other Meshy tabs.'));
    }).catch(error => { dbPromise = null; throw error; });
    return dbPromise;
  }

  let pendingSave = Promise.resolve();
  let revision = 0;
  function persist() {
    const snapshot = {
      meta: { status: state.status, glbSize: state.glb?.byteLength || 0,
        modelName: state.modelName, pageUrl: state.pageUrl, savedAt: Date.now(), revision: ++revision },
      glb: state.glb,
      textures: state.textures.slice()
    };
    pendingSave = pendingSave.then(async () => {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('files', 'readwrite');
        tx.objectStore('files').put(snapshot, 'session_' + sessionId);
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('Storage is unavailable'));
      });
      window.__meshyDLStorageError = '';
    }).catch(error => {
      window.__meshyDLStorageError = error.message;
      console.warn('[GrabThatMesh] Failed to save captured files:', error);
    });
  }

  // Drop legacy shared entries and document caches older than 24 hours.
  openDB().then(db => {
    const tx = db.transaction('files', 'readwrite');
    const request = tx.objectStore('files').openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (!String(cursor.key).startsWith('session_') ||
          cursor.value?.meta?.savedAt < Date.now() - 86400000) cursor.delete();
      cursor.continue();
    };
    tx.onerror = tx.onabort = () => console.warn('[GrabThatMesh] Cache cleanup failed');
  }).catch(error => { window.__meshyDLStorageError = error.message; });

  function loadButtonPosition() {
    try {
      const saved = localStorage.getItem('__meshyDLBtnPos');
      if (!saved) return null;
      const pos = JSON.parse(saved);
      if (!Number.isFinite(pos.left) || !Number.isFinite(pos.top)) return null;
      return pos;
    } catch (e) {
      return null;
    }
  }

  function saveButtonPosition(pos) {
    try {
      localStorage.setItem('__meshyDLBtnPos', JSON.stringify(pos));
    } catch (e) {}
  }

  // ── Floating button ────────────────────────────────────────────────────────
  function injectBtn() {
    if (document.getElementById('__meshyDLBtn')) return;
    const btn = document.createElement('button');
    btn.id = '__meshyDLBtn';
    btn.type = 'button';
    btn.title = 'Download the model; drag to reposition';
    btn.textContent = '⏳ GrabThatMesh';
    btn.style.cssText = `
      position:fixed;z-index:2147483647;
      background:#333;color:#fff;font:bold 13px monospace;
      padding:10px 16px;border-radius:8px;cursor:grab;
      box-shadow:0 4px 20px rgba(0,0,0,.5);transition:background .2s,border .2s;
      border:2px solid #555;user-select:none;touch-action:none;
    `;

    const savedPos = loadButtonPosition();
    if (savedPos) {
      btn.style.left = savedPos.left + 'px';
      btn.style.top = savedPos.top + 'px';
    } else {
      btn.style.right = '20px';
      btn.style.bottom = '20px';
    }

    let dragStart = null;
    let origin = null;
    let dragged = false;

    btn.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      dragged = false;
      btn.setPointerCapture(event.pointerId);
      btn.style.cursor = 'grabbing';
      btn.style.transition = 'none';

      const rect = btn.getBoundingClientRect();
      origin = { x: rect.left, y: rect.top };
      dragStart = { x: event.clientX, y: event.clientY };
    });

    btn.addEventListener('pointermove', event => {
      if (!dragStart) return;
      event.preventDefault();
      const dx = event.clientX - dragStart.x;
      const dy = event.clientY - dragStart.y;
      if (Math.hypot(dx, dy) > 5) dragged = true;
      if (!dragged) return;
      const left = Math.max(0, Math.min(window.innerWidth - btn.offsetWidth, origin.x + dx));
      const top = Math.max(0, Math.min(window.innerHeight - btn.offsetHeight, origin.y + dy));
      btn.style.left = left + 'px';
      btn.style.top = top + 'px';
      btn.style.right = 'auto';
      btn.style.bottom = 'auto';
    });

    btn.addEventListener('pointerup', event => {
      if (!dragStart) return;
      event.preventDefault();
      btn.releasePointerCapture(event.pointerId);
      btn.style.cursor = 'grab';
      btn.style.transition = 'background .2s,border .2s';
      dragStart = null;
      origin = null;
      saveButtonPosition({ left: btn.offsetLeft, top: btn.offsetTop });
    });

    btn.addEventListener('pointercancel', () => {
      if (!dragStart) return;
      btn.style.cursor = 'grab';
      btn.style.transition = 'background .2s,border .2s';
      dragStart = null;
      origin = null;
      saveButtonPosition({ left: btn.offsetLeft, top: btn.offsetTop });
    });

    btn.onclick = event => {
      if (dragStart || (dragged && event.detail !== 0)) return;
      checkNavigation();
      if (state.status !== 'ready') {
        btn.textContent = '⏳ Not ready yet...';
        return;
      }
      downloadAll();
    };

    document.body.appendChild(btn);
    const clampPosition = () => {
      const rect = btn.getBoundingClientRect();
      btn.style.left = Math.max(0, Math.min(window.innerWidth - rect.width, rect.left)) + 'px';
      btn.style.top = Math.max(0, Math.min(window.innerHeight - rect.height, rect.top)) + 'px';
      btn.style.right = btn.style.bottom = 'auto';
    };
    window.addEventListener('resize', clampPosition);
    updateBtn();
    clampPosition();
  }

  function downloadAll() {
    if (state.glb) dl(state.glb, state.modelName + '.glb', 'model/gltf-binary');
    state.textures.forEach((t, i) =>
      setTimeout(() => dl(t.buf, t.name, 'image/png'), 300 * (i + 1))
    );
  }

  function dl(buf, name, mime) {
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([buf], { type: mime })),
      download: name
    });
    document.body.appendChild(a);
    try { a.click(); }
    finally { a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); }
  }

  function updateBtn() {
    const btn = document.getElementById('__meshyDLBtn');
    if (btn) {
      btn.setAttribute('aria-disabled', String(state.status !== 'ready'));
      if (state.status !== 'ready') {
        btn.textContent = '⏳ Waiting for a model';
        btn.style.background = '#333';
        btn.style.border = '2px solid #555';
        return;
      }
      const texInfo = state.textures.length > 0 ? ` + ${state.textures.length} tex` : '';
      btn.textContent = `⬇️ GLB${texInfo} — Download`;
      btn.style.background = '#1f6feb';
      btn.style.border = '2px solid #58a6ff';
    }
  }

  // Wait until the document body is available
  if (document.body) injectBtn();
  else new MutationObserver((_, obs) => {
    if (document.body) { injectBtn(); obs.disconnect(); }
  }).observe(document, { childList: true, subtree: true });

  console.log('[GrabThatMesh] ✅ Extension loaded (MAIN world, document_start)');
})();

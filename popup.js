let currentTabId = null;
let meta = null;
let refreshing = false;
let downloading = false;
const button = document.getElementById('btnDl');

// This function is serialized into the page, so it has no popup dependencies.
async function accessPageCache(action, expectedRevision) {
  const sessionId = window.__meshyDLSession;
  if (!sessionId) return {};
  if (window.__meshyDLStorageError) throw new Error(window.__meshyDLStorageError);
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('meshy_dl', 2);
    let failed = false;
    const fail = error => { failed = true; clearTimeout(timer); reject(error); };
    const timer = setTimeout(() => fail(new Error('Storage is not responding.')), 5000);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('files')) request.result.createObjectStore('files');
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (failed) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => fail(request.error);
    request.onblocked = () => fail(new Error('Storage is blocked.'));
  });
  let record;
  try {
    record = await new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readonly');
      const request = tx.objectStore('files').get('session_' + sessionId);
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Unable to read captured files.'));
    });
  } finally {
    db.close();
  }
  if (!record || record.meta.pageUrl !== location.href || !record.glb) return {};
  if (action === 'download') {
    if (record.meta.revision !== expectedRevision) {
      throw new Error('The model has changed. Please try again.');
    }
    const safeName = name => String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 180) || 'model';
    const files = [{ buf: record.glb, name: safeName(record.meta.modelName) + '.glb', mime: 'model/gltf-binary' },
      ...record.textures.map(texture => ({ ...texture, name: safeName(texture.name), mime: 'image/png' }))];
    for (const file of files) {
      if (record.meta.pageUrl !== location.href) throw new Error('The page has changed.');
      const url = URL.createObjectURL(new Blob([file.buf], { type: file.mime }));
      const anchor = Object.assign(document.createElement('a'), { href: url, download: file.name });
      document.body.appendChild(anchor);
      try { anchor.click(); }
      finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
      if (file !== files[files.length - 1]) await new Promise(resolve => setTimeout(resolve, 300));
    }
    return { started: files.length };
  }
  return { meta: record.meta, texNames: record.textures.map(texture => texture.name) };
}

async function runInPage(tabId, action, revision) {
  const results = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN', func: accessPageCache, args: [action, revision ?? null]
  });
  return results?.[0]?.result || {};
}

function setStatus(type, text) {
  document.getElementById('dot').className = 'dot dot-' + type;
  document.getElementById('statusText').textContent = text;
}

function render(model, textures = []) {
  const list = document.getElementById('fileList');
  list.replaceChildren();
  button.disabled = downloading || !model || model.glbSize <= 0;
  if (!model || model.glbSize <= 0) return;
  const addRow = (name, badgeText, badgeClass, size) => {
    const row = document.createElement('div');
    row.className = 'file-row';
    const label = document.createElement('span');
    label.className = 'file-name';
    label.textContent = name;
    label.title = name;
    const badge = document.createElement('span');
    badge.className = 'badge ' + badgeClass;
    badge.textContent = badgeText;
    row.append(label, badge);
    if (size) {
      const detail = document.createElement('span');
      detail.className = 'file-size';
      detail.textContent = size;
      row.append(detail);
    }
    list.appendChild(row);
  };
  addRow((model.modelName || 'model') + '.glb', 'GLB', 'badge-glb', (model.glbSize / 1024 / 1024).toFixed(1) + ' MB');
  textures.forEach(name => addRow(name, 'PNG', 'badge-tex'));
}

async function refresh() {
  if (refreshing || downloading) return;
  refreshing = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url ? new URL(tab.url) : null;
    if (url?.origin !== 'https://www.meshy.ai') {
      currentTabId = null;
      meta = null;
      render(null);
      setStatus('idle', 'Not on a Meshy page');
      document.getElementById('hint').textContent = 'Open a model page on www.meshy.ai.';
      return;
    }
    currentTabId = tab.id;
    const data = await runInPage(tab.id, 'read');
    meta = data.meta;
    const textures = data.texNames || [];
    if (meta?.status === 'ready' && meta.glbSize > 0) {
      setStatus('ready', 'Model ready ✅');
      render(meta, textures);
      document.getElementById('hint').textContent = `${textures.length} ${textures.length === 1 ? 'texture' : 'textures'} captured.`;
    } else {
      render(null);
      setStatus('waiting', 'Waiting for a model...');
      document.getElementById('hint').textContent = 'Let the 3D viewer load. If needed, reload the page after installing the extension.';
    }
  } catch (error) {
    meta = null;
    render(null);
    setStatus('error', 'Unable to read captured files');
    document.getElementById('hint').textContent = error.message || String(error);
  } finally {
    refreshing = false;
  }
}

async function downloadAll() {
  if (currentTabId === null || !meta || refreshing || downloading) return;
  downloading = true;
  button.disabled = true;
  button.textContent = '⏳ Downloading...';
  try {
    const result = await runInPage(currentTabId, 'download', meta.revision);
    if (!result.started) throw new Error('The model is no longer available. Reload the viewer.');
    setStatus('ready', 'Downloads started');
    document.getElementById('hint').textContent = 'Check your browser downloads. Allow multiple downloads to save textures.';
  } catch (error) {
    setStatus('error', 'Download failed');
    document.getElementById('hint').textContent = error.message || String(error);
  } finally {
    downloading = false;
    button.disabled = !meta;
    button.textContent = '⬇️ Download all';
  }
}

button.addEventListener('click', downloadAll);
refresh();
const refreshTimer = setInterval(refresh, 2500);
window.addEventListener('pagehide', () => clearInterval(refreshTimer));

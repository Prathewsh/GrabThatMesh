const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element extends EventTarget {
  constructor(tag) { super(); this.tag = tag; this.style = {}; this.children = []; this.attrs = {}; this.disabled = false; }
  append(...items) { this.children.push(...items); }
  appendChild(item) { this.append(item); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(key, value) { this.attrs[key] = value; }
  getBoundingClientRect() { return { left: 20, top: 20, width: 100, height: 40 }; }
  remove() {}
  click() { this.clicked = true; }
  setPointerCapture() {}
  releasePointerCapture() {}
}

function database() {
  const records = new Map();
  let closed = 0;
  const db = {
    objectStoreNames: { contains: () => true },
    close() { closed++; },
    transaction() {
      const tx = { objectStore: () => store };
      const store = {
        put(value, key) { records.set(key, structuredClone(value)); },
        get(key) { return { result: records.get(key) }; },
        openCursor() {
          const request = {};
          const entries = [...records.entries()];
          const next = () => queueMicrotask(() => {
            const entry = entries.shift();
            request.result = entry ? { key: entry[0], value: entry[1], delete: () => records.delete(entry[0]), continue: next } : null;
            request.onsuccess?.();
          });
          next();
          return request;
        }
      };
      setImmediate(() => tx.oncomplete?.());
      return tx;
    }
  };
  return { records, get closed() { return closed; }, open() {
    const request = { result: db };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  } };
}

function browser(sharedDb = database(), bodyPresent = true) {
  const elements = {};
  for (const id of ['btnDl', 'fileList', 'dot', 'statusText', 'hint']) elements[id] = new Element('div');
  const body = new Element('body');
  const listeners = {};
  const intervals = [];
  const timeouts = [];
  let observed;
  class Worker extends EventTarget {
    emit(data) {
      const event = new Event('message');
      event.data = data;
      this.dispatchEvent(event);
      this.onmessage?.(event);
    }
  }
  const context = {
    console, ArrayBuffer, Uint8Array, DataView, URL, Blob, Request,
    crypto: require('node:crypto').webcrypto,
    Worker, indexedDB: sharedDb,
    location: { href: 'https://www.meshy.ai/model/one' },
    innerWidth: 900, innerHeight: 700,
    localStorage: { getItem: () => null, setItem() {} },
    fetch: async () => ({ ok: true, clone: () => ({ arrayBuffer: async () => new ArrayBuffer(8) }) }),
    document: {
      body: bodyPresent ? body : null, title: 'Example | Meshy',
      querySelector: () => null,
      getElementById: id => elements[id] || body.children.find(element => element.id === id),
      createElement: tag => new Element(tag)
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(target) { observed = target; }
      disconnect() {}
    },
    setInterval(callback) { intervals.push(callback); return intervals.length; },
    clearInterval() {},
    setTimeout(callback, ms) { timeouts.push({ callback, ms }); if (ms < 1000) queueMicrotask(callback); return timeouts.length; },
    clearTimeout() {},
    addEventListener(type, callback) { listeners[type] = callback; }
  };
  context.window = context;
  vm.createContext(context);
  return { context, elements, body, intervals, timeouts, sharedDb, get observed() { return observed; } };
}
const content = fs.readFileSync('content.js', 'utf8');
const popup = fs.readFileSync('popup.js', 'utf8');
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
function glb() {
  const buf = new ArrayBuffer(20);
  const view = new DataView(buf);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, 20, true);
  return buf;
}
function capture(env, data = glb()) {
  new env.context.Worker('/loader-worker.js').emit({ type: 'process', success: true, data });
}
function loadPopup(env, executeScript) {
  env.context.chrome = {
    tabs: { query: async () => [{ id: 1, url: env.context.location.href }] },
    scripting: { executeScript: executeScript || (async ({ func, args }) => [{ result: await func(...args) }]) }
  };
  vm.runInContext(popup, env.context);
}

test('capture preserves native event handlers and listener removal', async () => {
  const env = browser();
  vm.runInContext(content, env.context);
  const worker = new env.context.Worker('/loader-worker.js');
  let calls = 0;
  const listener = () => calls++;
  worker.addEventListener('message', listener);
  worker.removeEventListener('message', listener);
  worker.addEventListener('message', { handleEvent() { calls++; } });
  worker.onmessage = null;
  worker.emit({ type: 'process', success: true, data: glb() });
  assert.equal(calls, 1);
  await flush();
  assert.equal(env.sharedDb.records.get('session_' + env.context.__meshyDLSession).meta.glbSize, 20);
});

test('typed array views are captured using their byte offset', async () => {
  const env = browser();
  vm.runInContext(content, env.context);
  const bytes = new Uint8Array(30);
  bytes.set(new Uint8Array(glb()), 5);
  capture(env, bytes.subarray(5, 25));
  await flush();
  assert.equal(env.sharedDb.records.get('session_' + env.context.__meshyDLSession).glb.byteLength, 20);
});

test('malformed GLB is ignored without disrupting the worker', async () => {
  const env = browser();
  vm.runInContext(content, env.context);
  const buf = glb();
  new DataView(buf).setUint32(8, 999, true);
  capture(env, buf);
  await flush();
  assert.equal(env.sharedDb.records.size, 0);
});

test('document_start works before the document element exists', () => {
  const env = browser(undefined, false);
  vm.runInContext(content, env.context);
  assert.equal(env.observed, env.context.document);
});

test('tabs have independent cache entries and navigation clears the current model', async () => {
  const db = database();
  const first = browser(db);
  const second = browser(db);
  vm.runInContext(content, first.context);
  vm.runInContext(content, second.context);
  capture(first);
  capture(second);
  await flush();
  assert.equal(db.records.size, 2);
  first.context.location.href = 'https://www.meshy.ai/model/two';
  first.intervals[0]();
  await flush();
  assert.equal(db.records.get('session_' + first.context.__meshyDLSession).glb, null);
  assert.equal(db.records.get('session_' + second.context.__meshyDLSession).glb.byteLength, 20);
});

test('fetch supports URL objects and only captures the exact asset host', async () => {
  const env = browser();
  vm.runInContext(content, env.context);
  await env.context.fetch(new URL('https://assets.meshy.ai/texture.PNG?token=1'));
  await env.context.fetch('https://assets.meshy.ai.evil.example/wrong.png');
  await flush();
  const record = env.sharedDb.records.get('session_' + env.context.__meshyDLSession);
  assert.deepEqual(record.textures.map(item => item.name), ['texture.PNG']);
});

test('popup renders page-provided filenames as text and clears stale controls', async () => {
  const env = browser();
  loadPopup(env, async () => [{ result: { meta: { status: 'ready', glbSize: 20, modelName: '<img onerror=evil()>' }, texNames: [] } }]);
  await flush();
  assert.equal(env.elements.fileList.children[0].children[0].textContent, '<img onerror=evil()>.glb');
  assert.equal(env.elements.btnDl.disabled, false);
  env.context.location.href = 'https://www.meshy.ai.evil.example/';
  await env.context.refresh();
  assert.equal(env.elements.btnDl.disabled, true);
  assert.equal(env.elements.fileList.children.length, 0);
});

test('popup click starts downloads, closes database and schedules URL cleanup', async () => {
  const env = browser();
  vm.runInContext(content, env.context);
  capture(env);
  await flush();
  loadPopup(env);
  await flush();
  env.elements.btnDl.dispatchEvent(new Event('click'));
  await flush();
  assert.match(env.elements.statusText.textContent, /Downloads started/);
  assert.ok(env.sharedDb.closed >= 2);
  assert.ok(env.body.children.some(item => item.tag === 'a' && item.clicked));
  const cleanup = env.timeouts.filter(item => item.ms === 60000);
  assert.equal(cleanup.length, 1);
  cleanup.forEach(item => item.callback());
});

test('download failure restores the button and explains the failure', async () => {
  const env = browser();
  loadPopup(env, async ({ args }) => {
    if (args[0] === 'download') throw new Error('Tab closed');
    return [{ result: { meta: { status: 'ready', glbSize: 20, savedAt: 1 }, texNames: [] } }];
  });
  await flush();
  await env.context.downloadAll();
  assert.equal(env.elements.btnDl.disabled, false);
  assert.equal(env.elements.hint.textContent, 'Tab closed');
});

test('downloads reject a cache that changed after rendering', async () => {
  const env = browser();
  vm.runInContext(content, env.context);
  capture(env);
  await flush();
  loadPopup(env);
  await flush();
  await assert.rejects(env.context.accessPageCache('download', -1), /changed/);
});

test('manifest references existing assets and popup has no inline click handler', () => {
  const manifest = JSON.parse(fs.readFileSync('manifest.json'));
  for (const script of manifest.content_scripts.flatMap(entry => entry.js)) assert.ok(fs.existsSync(script));
  assert.ok(fs.existsSync(manifest.action.default_popup));
  assert.ok(!manifest.permissions.includes('downloads'));
  assert.doesNotMatch(fs.readFileSync('popup.html', 'utf8'), /onclick\s*=/i);
});

test('dragging the floating button does not download; keyboard activation still works', async () => {
  const env = browser();
  vm.runInContext(content, env.context);
  capture(env);
  await flush();
  const button = env.context.document.getElementById('__meshyDLBtn');
  const pointer = (type, x) => {
    const event = new Event(type);
    Object.assign(event, { button: 0, pointerId: 1, clientX: x, clientY: 20 });
    button.dispatchEvent(event);
  };
  pointer('pointerdown', 20);
  pointer('pointermove', 60);
  pointer('pointerup', 60);
  button.onclick({ detail: 1 });
  assert.equal(env.body.children.filter(item => item.tag === 'a').length, 0);
  button.onclick({ detail: 0 });
  assert.equal(env.body.children.filter(item => item.tag === 'a' && item.clicked).length, 1);
  env.timeouts.filter(item => item.ms === 60000).forEach(item => item.callback());
});

test('texture interception errors do not reject successful page fetches', async () => {
  const env = browser();
  const response = { ok: true, clone() { throw new Error('Already consumed'); } };
  env.context.fetch = async () => response;
  env.context.console = { log() {}, warn() {} };
  vm.runInContext(content, env.context);
  assert.equal(await env.context.fetch('https://assets.meshy.ai/texture.png'), response);
});

test('late textures from the previous page are discarded', async () => {
  const env = browser();
  let resolveTexture;
  const texture = new Promise(resolve => { resolveTexture = resolve; });
  env.context.fetch = async () => ({ ok: true, clone: () => ({ arrayBuffer: () => texture }) });
  vm.runInContext(content, env.context);
  await env.context.fetch('https://assets.meshy.ai/old.png');
  env.context.location.href = 'https://www.meshy.ai/model/two';
  resolveTexture(new ArrayBuffer(8));
  await flush();
  assert.equal(env.sharedDb.records.get('session_' + env.context.__meshyDLSession).textures.length, 0);
});

test('popup reads fail promptly when IndexedDB opening is blocked', async () => {
  const env = browser();
  env.context.__meshyDLSession = 'blocked-session';
  env.context.indexedDB = { open() {
    const request = {};
    queueMicrotask(() => request.onblocked());
    return request;
  } };
  loadPopup(env);
  await flush();
  assert.equal(env.elements.btnDl.disabled, true);
  assert.match(env.elements.hint.textContent, /blocked/);
});

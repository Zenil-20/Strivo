/**
 * Guards against the TV-browser failures we hit in practice. Runs against the production
 * build in client/dist (the `test` script builds it first):
 *  - "System is not defined"      -> a bundle used syntax newer than ES5
 *  - "Incompatible receiver, Symbol required" -> core-js broken by Babel's typeof rewrite
 *  - "fetch is not defined"       -> fetch polyfill missing
 *  - white text on white buttons  -> CSS variables without plain fallbacks
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import { parse } from 'acorn';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const assetsDir = path.join(dist, 'assets');
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const assetFiles = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
const read = (f) => fs.readFileSync(path.join(assetsDir, f), 'utf8');
const polyfillFile = assetFiles.find((f) => f.startsWith('polyfills-legacy-'));
const appFile = assetFiles.find((f) => f.startsWith('index-legacy-'));

test('index.html references only files that exist', () => {
  const refs = [...html.matchAll(/\/assets\/([^"']+\.js)/g)].map((m) => m[1]);
  assert.ok(refs.length >= 2, 'expected polyfill + app scripts');
  for (const ref of refs) assert.ok(assetFiles.includes(ref), `missing ${ref}`);
});

test('every script (bundles and inline) is plain ES5', () => {
  for (const f of assetFiles) {
    assert.doesNotThrow(() => parse(read(f), { ecmaVersion: 5, sourceType: 'script' }), f);
  }
  const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const code of inline) assert.doesNotThrow(() => parse(code, { ecmaVersion: 5 }), code.slice(0, 60));
});

test('polyfills work in an engine without Symbol, Promise, Map, Set, fetch', () => {
  const sandbox = vm.createContext({});
  vm.runInContext(
    `delete this.Symbol; delete this.Promise; delete this.Map; delete this.Set;
     delete this.WeakMap; delete this.WeakSet; delete this.Reflect; delete this.Proxy;
     delete Object.assign; delete Array.from; delete Array.prototype.includes;
     this.self = this; this.window = this; this.navigator = { userAgent: 'OldTV' };
     this.location = { href: 'http://tv/' }; this.addEventListener = function () {};
     this.setTimeout = function (fn) { fn(); };
     this.document = { baseURI: 'http://tv/', readyState: 'complete', currentScript: null,
       querySelectorAll: function () { return []; }, querySelector: function () { return null; },
       getElementsByTagName: function () { return []; }, addEventListener: function () {},
       createElement: function () { return {}; } };`,
    sandbox,
  );
  vm.runInContext(read(polyfillFile), sandbox, { filename: polyfillFile });
  vm.runInContext(
    `var s = Symbol('x'); String(s); s.toString(); s.description;
     for (var k in Symbol.prototype) {}
     Object.prototype.toString.call(s);
     [1, 2].includes(2); Array.from(new Set([1, 2])); new Map([[1, 2]]).get(1);
     if (typeof Promise !== 'function') throw new Error('Promise not polyfilled');
     if (typeof System === 'undefined') throw new Error('System (SystemJS) not defined');`,
    sandbox,
  );
});

test('the fetch() polyfill is bundled (old TVs have no fetch)', () => {
  assert.ok(read(appFile).includes('Body not allowed for GET or HEAD requests'));
});

test('every CSS var() has a plain fallback value before it', () => {
  const css = read(appFile).replace(/\\r\\n|\\n/g, '\n');
  const uses = [...css.matchAll(/([a-z-]+):\s*var\(--[a-z-]+\)/g)];
  assert.ok(uses.length > 10, 'expected CSS in the bundle');
  const missing = uses.filter((m) => {
    const before = css.slice(Math.max(0, m.index - 150), m.index);
    return !new RegExp(`${m[1]}:\\s*[^;{}]+;\\s*$`).test(before);
  });
  assert.deepEqual(missing.map((m) => m[0]), []);
});

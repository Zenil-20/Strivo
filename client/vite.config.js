import { createHash } from 'node:crypto';
import { transformSync } from '@babel/core';
import legacy from '@vitejs/plugin-legacy';
import react from '@vitejs/plugin-react';
import { parse } from 'acorn';
import postcssCustomProperties from 'postcss-custom-properties';
import { defineConfig } from 'vite';

/**
 * The polyfill chunk's file name hash was computed BEFORE we changed its code. Re-emit it
 * under a new content hash, so browsers (which cache /assets for an hour) never keep an
 * older, broken copy, and point index.html / other chunks at the new name.
 * (Rolldown doesn't allow adding entries to `bundle` directly, hence this.emitFile.)
 */
function renameChunk(ctx, bundle, file) {
  const hash = createHash('sha256').update(file.code).digest('base64url').slice(0, 8);
  const oldName = file.fileName;
  const newName = oldName.replace(/-[\w-]{8}\.js$/, `-${hash}.js`);
  if (newName === oldName) return;
  const { code } = file;
  delete bundle[oldName];
  ctx.emitFile({ type: 'asset', fileName: newName, source: code });
  for (const other of Object.values(bundle)) {
    if (other.type === 'asset' && typeof other.source === 'string') {
      other.source = other.source.split(oldName).join(newName);
    } else if (other.type === 'chunk') {
      other.code = other.code.split(oldName).join(newName);
    }
  }
}

/**
 * Old TV browsers only understand ES5 JavaScript (no arrow functions, const/let,
 * `template strings`). Two things still sneak newer syntax into the legacy build:
 *  - the bundler's own helper that wraps the polyfill file uses arrow functions;
 *  - (fixed by using terser below) the default minifier emits template strings.
 * This plugin converts the polyfill chunk to ES5 with Babel, then checks EVERY output
 * file really is ES5 and fails the build otherwise, so a white TV screen can't come back.
 */
function ensureEs5() {
  return {
    name: 'strivo:ensure-es5',
    apply: 'build',
    enforce: 'post',
    generateBundle(_, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') continue;
        const isPolyfills = file.fileName.includes('polyfills-legacy');
        const originalCode = file.code;
        if (isPolyfills) {
          file.code = transformSync(file.code, {
            babelrc: false,
            configFile: false,
            compact: true,
            sourceType: 'script',
            // Syntax only. `transform-typeof-symbol` is excluded: rewriting core-js's own
            // `typeof x == 'symbol'` checks breaks its Symbol polyfill on engines without
            // Symbol ("TypeError: Incompatible receiver, Symbol required" on the TV).
            presets: [
              [
                '@babel/preset-env',
                { targets: 'ie 11', modules: false, useBuiltIns: false, exclude: ['transform-typeof-symbol'] },
              ],
            ],
          }).code;
        }
        try {
          parse(file.code, { ecmaVersion: 5, sourceType: 'script' });
        } catch (err) {
          this.error(`${file.fileName} is not valid ES5 (old TV browsers would fail): ${err.message}`);
        }
        if (isPolyfills && file.code !== originalCode) renameChunk(this, bundle, file);
      }
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    // TV browsers (Android TV WebView, built-in "Browser" apps) often run an engine that is
    // years old. Vite's default output needs ~Chrome 107+, so on those TVs the page stayed
    // white. We ship ONE down-compiled bundle (+ polyfills) that every browser can run.
    // Trade-off: modern browsers get a slightly bigger file, but we avoid the extra
    // inline "is this a modern browser?" scripts that our CSP would otherwise block.
    // Targets include IE 11: that forces plain ES5 output (no const/let/arrow functions),
    // which the oldest TV engines (pre-Chrome-49 WebViews, old WebKit/Opera) require.
    legacy({
      targets: ['ie >= 11', 'chrome >= 30', 'android >= 4.4', 'safari >= 9', 'firefox >= 45'],
      renderModernChunks: false,
    }),
    ensureEs5(),
  ],
  css: {
    postcss: {
      // Old TV engines (before ~Chrome 49) ignore CSS variables, which left e.g. white text
      // on white buttons. This writes a plain value before each var(): `color: #2f6fed;
      // color: var(--accent)`. New browsers use the variable (and dark mode), old ones the fallback.
      plugins: [postcssCustomProperties({ preserve: true })],
    },
  },
  build: {
    // plugin-legacy minifies legacy chunks with Oxc using a hard-coded "es2015" target,
    // which re-introduces `template literals` that old TV engines cannot parse.
    // Terser keeps the ES5 output of Babel intact.
    minify: 'terser',
    terserOptions: { ecma: 5, safari10: true },
    // The CSS minifier treats `color: #1c1f24; color: var(--text)` as a duplicate and deletes
    // the fallback, whatever target it is given. Our CSS is ~5 kB, so skip CSS minification.
    cssMinify: false,
  },
  server: {
    port: 5173,
    strictPort: true,
    host: true, // reachable from phone/TV on the Wi-Fi during development too
    // API calls are relative (/api/...), so in dev forward them to Express.
    proxy: { '/api': 'http://localhost:5000' },
  },
});

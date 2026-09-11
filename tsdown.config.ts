import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

/**
 * The client module id the Host boot graph looks up. It must equal the package
 * name: `client-modules` matches each `/plugins/??<id>/client.js` row against
 * what the bundle registers through `__ModuleLoader__.load`, and a mismatch
 * fails the whole client graph ("loaded without registering ..."). Deriving it
 * from the manifest keeps a rename from silently desynchronizing the two.
 */
const packageName: string = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).name

export default defineConfig([{
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-host-webserver',
    ],
  },
}, {
  entry: ['src/cli.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: false,
  sourcemap: true,
  clean: false,
  outputOptions: { entryFileNames: 'cli.js' },
}, {
  entry: { client: 'src/client.ts' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: { neverBundle: ['react'] },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageName)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}, {
  entry: { 'mobile-layout': 'src/mobile-layout.ts' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: { neverBundle: ['react'] },
  outputOptions: {
    entryFileNames: 'mobile-layout.js',
    banner: 'window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-client-ui-layout", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}])

import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Packages the SDK's CJS build still require()s at runtime. */
const SDK_RUNTIME_DEPS = ['@bufbuild/protobuf', '@connectrpc/connect', '@connectrpc/connect-web', 'zod'];

const copyFilter = (src) => !/\.d\.[cm]?ts(\.map)?$|\.js\.map$|[\\/]zod[\\/]src([\\/]|$)/.test(src);

/**
 * Copies the CommonJS build of @cursor/sdk next to the bundle so it can be
 * loaded at runtime (the SDK is external: it ships dynamic requires that must
 * not be inlined). Skips esm/bundled copies, type declarations and sourcemaps.
 */
async function vendorCursorSdk() {
  const sdkEntry = require.resolve('@cursor/sdk');
  const sdkRoot = resolve(dirname(sdkEntry), '..', '..');
  const target = resolve('dist/vendor/cursor-sdk');
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(resolve(sdkRoot, 'package.json'), resolve(target, 'package.json'));
  await cp(resolve(sdkRoot, 'LICENSE.md'), resolve(target, 'LICENSE.md'));
  await cp(resolve(sdkRoot, 'dist/cjs'), resolve(target, 'dist/cjs'), {
    recursive: true,
    dereference: true,
    filter: copyFilter,
  });

  // The packaged extension has no node_modules, so ship the SDK's runtime
  // dependencies next to it where Node's resolution will find them.
  const nodeModulesDir = resolve(sdkRoot, '..', '..');
  for (const dep of SDK_RUNTIME_DEPS) {
    await cp(resolve(nodeModulesDir, dep), resolve(target, 'node_modules', dep), {
      recursive: true,
      dereference: true,
      filter: copyFilter,
    });
  }
}

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode', '@cursor/sdk'],
    logLevel: 'info',
    plugins: [],
  });

  if (watch) {
    await vendorCursorSdk();
    await ctx.watch();
    console.log('Watching...');
  } else {
    await ctx.rebuild();
    await vendorCursorSdk();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

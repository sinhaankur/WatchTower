/* eslint-disable no-console */
/**
 * Bundle the WatchTower VS Code extension into a single CJS file under
 * out/extension.js. Replaces the old `tsc -p ./` emit which produced four
 * separate files plus source maps and shipped them all in the .vsix —
 * unnecessary on disk and slower to activate (each require() is a syscall).
 *
 * Modes:
 *   node esbuild.config.cjs              — dev build (sourcemap, no minify)
 *   node esbuild.config.cjs --production — release build (minify, no sourcemap)
 *   node esbuild.config.cjs --watch      — dev build, rebuild on file change
 *
 * VS Code loads extensions in the host's Node runtime (CJS), so we target
 * `node` platform with `cjs` format. `vscode` itself is a runtime-injected
 * module, never imported from disk — mark it external so esbuild doesn't
 * try to resolve it.
 */
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  platform: "node",
  // VS Code 1.80 ships Node 18.15. Targeting node18 lets esbuild use newer
  // language features without polyfills. Bumping vscode minimum upward in
  // the future means this number can also rise.
  target: "node18",
  format: "cjs",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  // VS Code's extension host warns about top-level eval / dynamic import;
  // we don't use either, but keeping the default loose check is fine.
  logLevel: "info",
  // Smaller .vsix — strip license/copyright comments from minified output.
  legalComments: production ? "none" : "linked",
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("[esbuild] watching for changes…");
    return;
  }
  const result = await esbuild.build(options);
  if (result.errors.length) {
    console.error("[esbuild] build failed");
    process.exit(1);
  }
  console.log(
    `[esbuild] ${production ? "production" : "dev"} build complete -> out/extension.js`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

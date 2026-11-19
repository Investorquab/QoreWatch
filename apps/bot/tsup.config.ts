import { defineConfig } from "tsup";

/** One self-contained server file: dist/main.js. Native and large deps stay external (installed on the server). */
export default defineConfig({
  entry: { main: "src/main.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  removeNodeProtocol: false,
  noExternal: ["@qorewatch/core"],
  external: ["@resvg/resvg-js", "node:sqlite"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

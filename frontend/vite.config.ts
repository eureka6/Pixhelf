import { defineConfig } from "vite";
import { readFile, readdir } from "node:fs/promises";
import manifest from "./libmedia-assets.json";

// Keep libmedia's prebuilt ESM chunks together: its workers resolve them relative
// to avplayer.js. Serving them directly also avoids rebundling the Wasm runtime.
async function libmediaFiles() {
  const esm = new URL("./node_modules/@libmedia/avplayer/dist/esm/", import.meta.url);
  const files = new Map<string, URL>();
  for (const name of await readdir(esm)) if (name.endsWith(".js")) files.set(name, new URL(name, esm));
  const cache = new URL(`./node_modules/.cache/libmedia-${manifest.version}/`, import.meta.url);
  for (const entry of manifest.files) files.set(`wasm/${entry.path}`, new URL(entry.path, cache));
  files.set("COPYING.LGPLv3", new URL("./node_modules/@libmedia/avplayer/COPYING.LGPLv3", import.meta.url));
  return files;
}

export default defineConfig({
  plugins: [{
    name: "libmedia-assets",
    async generateBundle() {
      for (const [name, path] of await libmediaFiles()) {
        this.emitFile({ type: "asset", fileName: `assets/libmedia/${name}`, source: await readFile(path) });
      }
    },
    async configureServer(server) {
      const files = await libmediaFiles();
      server.middlewares.use(async (request, response, next) => {
        const path = request.url?.split("?")[0] ?? "";
        const prefix = "/assets/libmedia/";
        const file = path.startsWith(prefix) ? files.get(path.slice(prefix.length)) : undefined;
        if (!file) return next();
        try {
          response.setHeader("Content-Type", path.endsWith(".wasm") ? "application/wasm" : path.endsWith(".js") ? "text/javascript" : "text/plain");
          response.end(await readFile(file));
        } catch (error) { next(error); }
      });
    },
  }],
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: "assets/app.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: (asset) =>
          asset.name?.endsWith(".css") ? "assets/app.css" : "assets/[name][extname]",
      },
    },
  },
});

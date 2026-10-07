import { readFile } from "node:fs/promises";

// Serve every emitted chunk so browser fixtures exercise the production split.
export async function serveFrontendAsset(route) {
  const path = new URL(route.request().url()).pathname;
  if (!path.startsWith("/assets/") || path.includes("..")) throw new Error(`Invalid asset path: ${path}`);
  const body = await readFile(new URL(`../dist${path}`, import.meta.url));
  const contentType = path.endsWith(".css") ? "text/css" : path.endsWith(".wasm") ? "application/wasm" : "text/javascript";
  return route.fulfill({ body, contentType });
}

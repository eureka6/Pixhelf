import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const runner = new URL("../.local-tests/run.mjs", import.meta.url);
try {
  await access(runner);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  console.error("本地专项测试未安装。请复制测试包到 frontend/.local-tests/，然后在该目录运行 npm ci。详见 docs/DEVELOPMENT.md。\n基础检查：npm --prefix frontend test");
  process.exit(1);
}
process.argv[1] = fileURLToPath(runner);
await import(runner.href);

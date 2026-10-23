# 开发指南

Pixhelf 使用 Rust / Axum 提供接口，Preact / TypeScript 提供界面；正式构建将前端资源嵌入 Rust 程序。

## 模块分工

| 位置 | 职责 |
| --- | --- |
| `frontend/src/App.tsx`、`app/` | 页面组装、图库数据、相似搜索及查看器返回状态 |
| `frontend/src/ImageViewer.tsx`、`useViewer*.ts` | 看图、导航、预加载和资源生命周期 |
| `frontend/src/galleryLoading.ts`、`networkPolicy.ts` | 缩略图加载、分页预取和网络策略 |
| `frontend/src/api/`、`api.ts`、`types.ts` | 请求、运行时校验和接口类型 |
| `frontend/src/hooks/` | 视口、媒体查询、防抖与过渡 hooks |
| `src/web.rs`、`src/web/` | 路由、鉴权装配、查询、媒体响应及 HTTP 缓存 |
| `src/auth/`、`management/`、`storage/` | 账号、文件管理和外部存储 |
| `src/gallery.rs`、`thumbs.rs`、`video_jobs.rs`、`text_search/` | 扫描、媒体处理与搜索模型 |
| `src/monitor/`、`src/web/system/`、`frontend/src/System*.tsx` | 系统采样、历史记录与监控界面 |

请求状态、取消与清理逻辑放在拥有它们的 hook 或业务模块中；`App.tsx` 通过返回值和回调协调模块。修改接口时同步维护后端响应类型、`types.ts` 和 `api/validators.ts`；管理操作沿用管理路由的鉴权。

## 本地开发

需要 Linux、[固定版本的 Rust](../rust-toolchain.toml)、[固定版本的 Node.js](../.node-version) 和 npm。首次构建还会编译媒体组件，C / musl 工具链、NASM、pkg-config、Meson、Ninja 的安装清单见[构建脚本](../.forgejo/actions/build-release/action.yml)。使用 fnm 时可运行 `fnm install && fnm use`。

从项目根目录准备前端和测试图库：

```bash
npm --prefix frontend ci
npm --prefix frontend run build
mkdir -p target/dev/gallery
```

把测试媒体放入 `target/dev/gallery`。终端一启动后端：

```bash
PIXHELF_AUTH_ENABLED=false PIXHELF_SKIP_FRONTEND_BUILD=1 cargo run -- \
  --listen 127.0.0.1:3002 \
  --gallery-dir target/dev/gallery --cache-dir target/dev/cache \
  --text-search-model false
```

终端二启动前端：

```bash
npm --prefix frontend run dev -- --host 127.0.0.1
```

访问 `http://127.0.0.1:5173`。Vite 将 `/api` 转发到 `127.0.0.1:3002`，可通过 `PIXHELF_API_TARGET` 覆盖地址。界面修改会热更新，Rust 修改后重启后端。

此模式仅用于本机界面开发。验证登录和访客权限时，去掉 `PIXHELF_AUTH_ENABLED=false`，重新构建前端并通过 `http://127.0.0.1:3002` 访问 Rust 服务。`PIXHELF_SKIP_FRONTEND_BUILD=1` 复用已有 `frontend/dist`；前端改动后应先重新构建。

## 验证

```bash
npm --prefix frontend run build
cargo fmt --all -- --check
PIXHELF_SKIP_FRONTEND_BUILD=1 cargo test --locked
```

前端构建包含类型检查；只检查类型时运行 `npm --prefix frontend test`。Rust 测试和发布自检随源码维护，共用 `frontend/scripts/fixtures/` 中的媒体样本。

JavaScript 专项检查保存在 Git 忽略的 `frontend/.local-tests/`。新克隆需另行复制测试包并安装依赖：

```bash
npm --prefix frontend/.local-tests ci
node frontend/.local-tests/node_modules/playwright-core/cli.js install chromium
npm --prefix frontend run test:local -- --list
```

| 范围 | 命令（从项目根目录执行） |
| --- | --- |
| 算法、请求取消、缓存与轮询 | `npm --prefix frontend run test:local -- quick` |
| 图库、导航、查看器与系统信息 | `npm --prefix frontend run test:local -- ui` |
| 实况照片、视频预览与幻灯片 | `npm --prefix frontend run test:local -- media` |
| 登录、管理、存储与媒体集成 | `npm --prefix frontend run test:local -- backend` |
| 所有自动准备环境的检查 | `npm --prefix frontend run test:local -- all` |
| 指定检查 | `npm --prefix frontend run test:local -- system-information viewer-preload` |

同一次调用按需构建前后端各一次，并对检查去重；默认继续运行、汇总失败，日志保存在 `.local-tests/results/`。支持 `--no-build` 复用产物、`--fail-fast` 首错停止、`--dry-run` 查看计划及 `--timeout=600` 调整单项时限（默认 300 秒）。测试包缺失、失败、超时或未完成均返回非零退出码。

浏览器可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定，媒体检查需要系统 FFmpeg / FFprobe。`manual` 检查需显式提供 `PIXHELF_URL` 或 `PIXHELF_PINE_SAMPLES`，不会纳入 `all`；`startup` 因旧扫描暂停夹具失效而停用。详细场景和参数见本地测试包的 `README.md`。

旧的 `npm run 名称-check` 改为 `test:local -- 名称`；`album-hierarchy` 并入 `local-storage`，`live-photo` 是 `live-photo-app` 的别名。本地测试包应单独备份，Git 克隆与源码归档不会携带它。

发布流程见[构建与发布](BUILD.md)，加载与缓存设计见[加载性能](PERFORMANCE.md)。

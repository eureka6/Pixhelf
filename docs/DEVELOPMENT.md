# 开发指南

Pixhelf 使用 Rust / Axum 提供接口，Preact / TypeScript 提供界面。正式构建把前端资源嵌入 Rust 二进制；日常界面开发可以单独启动 Vite，修改后直接热更新。

## 模块分工

| 位置 | 职责 |
| --- | --- |
| `frontend/src/App.tsx` | 组装页面、导航、选择和查看器历史 |
| `frontend/src/app/useGalleryData.ts` | 首屏数据、图库和任务状态轮询、搜索、防抖、分页及请求取消 |
| `frontend/src/app/useViewerSimilarSearch.ts` | 查看器内的相似图片与视频帧查询、分页和恢复 |
| `frontend/src/app/useViewerReturn.ts` | 返回图库或上层查看器时的滚动、动画与观察器生命周期 |
| `frontend/src/app/viewerReturnSnapshot.ts` | 创建和释放返回动画使用的临时 DOM / canvas |
| `frontend/src/galleryLoading.ts` | 缩略图与分页预加载距离、可见图片优先级及共享观察器 |
| `frontend/src/useViewerNavigation.ts` | 感应区长按、方向键和鼠标侧键共用的加速节奏、分页等待及取消 |
| `frontend/src/ImageViewer.tsx`、`ViewerNavigationButton.tsx` | 图片拖动、缩放与感应区手势交接；按钮保留显示和辅助操作入口 |
| `frontend/src/hooks/` | 不依赖图库业务的视口、媒体查询、防抖和过渡 hooks |
| `frontend/src/api.ts` | 页面调用的图库接口与请求参数 |
| `frontend/src/api/request.ts` | JSON 请求、超时、取消和错误处理 |
| `frontend/src/api/validators.ts` | 服务端数据的运行时校验 |
| `frontend/src/types.ts` | 前端接口类型；和后端序列化结构一起维护 |
| `src/web.rs` | 应用状态、路由注册、鉴权及公共中间件装配 |
| `src/web/models.rs` | 查询参数归一化与响应结构 |
| `src/web/listing.rs`、`pagination.rs` | 图库列表、文字搜索和分页排序 |
| `src/web/similarity.rs`、`duplicates.rs` | 相似图片排序与重复文件检测，各自维护缓存 |
| `src/web/details.rs` | 元数据、直方图和详情缓存 |
| `src/web/media.rs`、`video.rs` | 图片、缩略图、视频及实况照片的文件响应 |
| `src/web/frontend.rs`、`cache.rs` | 页面初始数据、内嵌资源和 HTTP 缓存头 |
| `src/auth/`、`management/`、`storage/` | 账号、文件管理和外部存储 |
| `src/gallery.rs`、`thumbs.rs`、`video_jobs.rs`、`text_search/` | 扫描索引、缩略图、视频任务和搜索模型 |

开发新功能时，把请求状态、取消逻辑和清理动作放在拥有它们的 hook 中；`App.tsx` 通过返回值和回调协调模块。后端 handler 使用 `ReadState` 读取按权限过滤的图库，管理操作沿用管理路由的鉴权。跨模块显式导入依赖，缓存留在对应业务模块内。

修改接口时同步维护 `models.rs`（或对应业务模块的响应类型）、`types.ts` 和 `api/validators.ts`。路由与鉴权中间件集中在 `web.rs`，新增 handler 在此注册。

## 本地启动

需要 Linux、Rust stable、支持 Vite 7 的 Node.js（22.12+）和 npm。首次 Rust 构建还会编译媒体组件，需要 C / musl 工具链、NASM、pkg-config、Meson 和 Ninja；完整安装清单及跨架构配置见[构建流程](../.forgejo/actions/build-release/action.yml)。

在项目根目录安装依赖并构建一次前端：

```bash
npm --prefix frontend ci
npm --prefix frontend run build
mkdir -p target/dev/gallery
```

将开发用图片放入 `target/dev/gallery`。在第一个终端启动仅监听本机的开发后端：

```bash
PIXHELF_AUTH_ENABLED=false PIXHELF_SKIP_FRONTEND_BUILD=1 cargo run -- \
  --listen 127.0.0.1:3002 \
  --gallery-dir target/dev/gallery --cache-dir target/dev/cache \
  --text-search-model false
```

在第二个终端启动前端：

```bash
npm --prefix frontend run dev -- --host 127.0.0.1
```

打开 `http://127.0.0.1:5173`。Vite 将 `/api` 请求转发到 `http://127.0.0.1:3002`；后端端口不同时，可在启动 Vite 的命令前设置 `PIXHELF_API_TARGET=http://127.0.0.1:其他端口`。界面改动由 Vite 热更新，Rust 改动后重启后端。

Vite 的 HTML 没有服务端注入的登录状态，因此上述模式只用于本机界面开发。验证登录、访客权限或完整打包行为时，去掉 `PIXHELF_AUTH_ENABLED=false`，执行 `npm --prefix frontend run build` 后启动 Rust 服务，访问 `http://127.0.0.1:3002`。

`PIXHELF_SKIP_FRONTEND_BUILD=1` 复用已有 `frontend/dist`，方便只改后端；不设置时，Cargo 会在前端源码变化后自动构建前端。

## 验证

从项目根目录执行：

```bash
npm --prefix frontend run typecheck
npm --prefix frontend run build
cargo fmt --all -- --check
PIXHELF_SKIP_FRONTEND_BUILD=1 cargo test --locked
```

浏览器检查使用 `playwright-core`，需要已安装的 Chromium；非默认路径可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定。根据改动选择现有检查：

| 改动 | 命令（在 `frontend/` 中执行） |
| --- | --- |
| 请求生命周期 | `npm run request-lifecycle-check` |
| 跨区域加载、后台请求 | `npm run network-loading-check`、`npm run network-policy-check` |
| 瀑布流慢网滚动、缩略图优先级 | `npm run waterfall-loading-check` |
| 图片和实况预加载、视频读取 | `npm run viewer-preload-check`、`npm run live-photo-preload-check`、`npm run media-source-check` |
| 查看器切图速度、原图复用 | `npm run viewer-switch-loading-check`、`npm run viewer-original-cache-check` |
| 查看器拖动、缩放和连续切图 | `npm run viewer-interaction-check`、`npm run viewer-keyboard-check` |
| 图库筛选、搜索、重复图片 | `npm run image-filters-check`、`npm run image-search-check`、`npm run duplicates-check` |
| 导航、移动端视口 | `npm run navigation-controls-check`、`npm run mobile-viewport-navigation-check` |
| 页面切换和分页竞争 | `npm run ui-stress-check` |
| 查看器历史、返回定位、选择和管理 | `npm run management-check` |
| 登录、会话和访客权限 | `npm run auth-check` |

`management-check` 和 `auth-check` 会启动后端并使用临时图库，先执行 `PIXHELF_SKIP_FRONTEND_BUILD=1 cargo build --locked` 更新 `target/debug/pixhelf`。其它专用检查及夹具位于 `frontend/scripts/`；后端接口回归位于 `src/web/tests.rs`，模块算法测试放在对应模块内。

连续切图的计时参数集中在 `useViewerNavigation.ts`：按住 400 毫秒后开始重复，逐步加速到每 170 毫秒一张。键盘与鼠标侧键在按下时先切一张，感应区点按在松手时切一张；感应区移动超过手势阈值后交给图片拖动，取消长按及松手点按。分页等待不会累积切图次数或继续加速；重复切图松手、失焦或关闭后立即取消。

`startup-check` 的旧扫描暂停夹具依赖 PATH 中的 FFprobe，当前内置媒体运行时不会调用它，需要更新夹具后再使用。首次扫描期间的接口保护已由后端测试覆盖。

跨区域加载策略、缓存规则和模拟网络复测方法见[加载性能](PERFORMANCE.md)。

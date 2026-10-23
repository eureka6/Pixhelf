# 加载性能

## 加载与缓存策略

| 范围 | 策略与主要实现 |
| --- | --- |
| 首屏 | 按 Vite manifest 预加载图库依赖；设置、上传、存储和重复图片等页面按需加载。见 `src/web/frontend.rs` |
| 静态资源 | 构建时生成 JS / CSS 的 Brotli 表示；版本化地址使用长期缓存，Wasm 分组存储。见 `frontend/scripts/pack-assets.mjs` |
| 缩略图与分页 | 可见图片优先；预取附近约 1.5–2 屏缩略图，分页再提前一屏；共享观察器随组件释放。见 `galleryLoading.ts` |
| 原图 | 先完成当前图片，再沿翻页方向预取邻图；复用进行中的请求，转向时取消无关下载。见 `useViewerPreloads.ts`、`viewerAssets.ts` |
| 网络限制 | 根据省流模式、带宽、RTT 和文档请求耗时调整预取范围。见 `networkPolicy.ts` |
| 媒体片段 | 首个 Range 请求同时读取长度与可播放字节，后续读取复用响应流；不完整响应会报错并释放下载。见 `mediaSource.ts` |
| 后台轮询 | 页面隐藏、离线或离开时取消请求，恢复时刷新，过时结果不能重启轮询。见 `app/visiblePolling.ts` |

以上未标目录的前端文件均位于 `frontend/src/`。查看器缓存受数量和内存预算约束；关闭查看器或进入后台会清理过时任务。手机使用视口位图渲染，完整原图字节供放大和再次查看复用。

## 复测

安装本地测试包后，从项目根目录执行；入口只构建一次所需前端和后端，安装方法见[开发指南](DEVELOPMENT.md#验证)。

```bash
npm --prefix frontend run test:local -- \
  network-loading network-policy waterfall-loading viewer-preload \
  viewer-switch-loading viewer-original-cache media-source live-photo-preload
```

| 检查 | 场景 | 可选报告路径变量 |
| --- | --- | --- |
| `network-loading` | 250 ms 延迟、2 Mbps 下载，测量桌面与手机冷启动、首屏和首次看图 | `PIXHELF_NETWORK_REPORT` |
| `waterfall-loading` | 180 张分页图片、缩略图延迟 600 ms、分页延迟 700 ms，连续滚动检查加载与请求复用 | `PIXHELF_WATERFALL_REPORT` |
| `viewer-switch-loading` | 原图延迟 600 ms、每张停留 900 ms，检查切图、反向翻页与预取范围 | `PIXHELF_VIEWER_SWITCH_REPORT` |

这些是固定夹具的模拟网络结果。比较改动前后时使用相同版本的样本、浏览器和参数，并同时检查请求数量、传输量与耗时；小图模拟不能代表大文件持续占用带宽或真实跨区域线路。

## 反向代理

前端资源嵌入 Rust 程序，改动后需要替换服务程序或容器镜像。代理应保留 `Content-Encoding`、`Cache-Control`、`ETag`、`Vary`，并正确转发媒体 Range 请求。

公共长期缓存仅用于版本化的 `/assets/`。鉴权后的页面和媒体遵循服务端返回的 `no-store` / `private, no-cache` 策略，媒体条件请求仍需验证会话与可见性。

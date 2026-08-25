# Pixhelf

基于 Axum 和 Preact 的自托管图片画廊。Preact 生产资源会嵌入 Rust 可执行文件，运行时只需要一个程序文件和外部图库目录。

## 运行

默认从当前工作目录的 `./pic` 读取图片，并监听 `0.0.0.0:3002`：

```bash
./target/release/pixhelf
```

HTTP 服务会立即开放，并优先生成首批 60 张缩略图。每张图片只生成一套最长边 720px、质量 82 的高质量 WebP 缩略图；其余缩略图由后台任务持续处理。新增、修改或删除图片会在定期扫描后自动同步，图库为空时也可正常启动并等待后续图片。

首屏图库数据与压缩后的关键样式会随 HTML 一并下发，首张图片会提前加载。JS 使用内容版本化的长期缓存，API 使用 ETag 协商缓存，并按浏览器能力启用 Brotli 或 gzip 压缩。

缩略图缓存在 `./.pixhelf-cache/thumbnails` 下的单一版本化目录，原图不会被修改。查看器拥有独立于瀑布流可见性的资源队列：已经解码的显示资源会直接复用，不再回退到缩略图；桌面端使用原图，移动端在原图像素不超过屏幕目标时也直接使用原图，大图则在当前图片稳定后从中性色缩略图升级到与视口及 DPR 匹配的高质量位图。全分辨率大图只在放大时按需加载，复位后回到更适合屏幕采样的视口位图，连续切图会取消过期升级任务。缩略图不做额外亮度或饱和度处理，升级时由高质量图层覆盖淡入，避免透明度叠加造成画面先暗后亮。只有超过安全边界的极端大图才绘制到 GPU 安全画布。查看器支持键盘方向键、鼠标前进/后退侧键和滚轮缩放，以及移动端滑动、双击和双指缩放；在适应屏幕状态下继续向下滚动或上滑，可从图片首屏连续进入详情第二屏。关闭查看器时会在瀑布流布局稳定后把当前图片动画送回对应卡片，即使期间发生续载或窗口尺寸变化也会重新锁定落点。窗口宽度引发瀑布流重排时，会按图片 ID 保持当前焦点或视口中心图片的相对位置。缓存目录必须位于图库目录之外。

## 构建

需要当前稳定版 Rust、Node.js 20+ 和 npm：

```bash
cd frontend
npm ci
cd ..
cargo build --release
```

`cargo build` 会自动执行 React 生产构建，并将结果嵌入 `target/release/pixhelf`。

发布工作流使用 musl 静态链接，并在同一台 AMD64 构建机上交叉编译两个版本：

- `pixhelf-amd64-linux`：`x86_64-unknown-linux-musl`
- `pixhelf-arm64-linux`：`aarch64-unknown-linux-musl`

两个 Release 产物都是无扩展名的独立可执行文件，下载后需要执行
`chmod +x pixhelf-amd64-linux` 或 `chmod +x pixhelf-arm64-linux`。

## Docker

每个版本同时发布 `linux/amd64` 和 `linux/arm64` 镜像。Docker 会自动选择与宿主机匹配的架构：

```bash
mkdir -p pic
docker compose up -d
```

默认读取当前目录的 `./pic`，监听宿主机的 `3002` 端口，并使用命名卷保存缩略图缓存。
可以通过环境变量指定版本、图库目录和端口：

```bash
PIXHELF_TAG=0.1.8 \
PIXHELF_GALLERY=/srv/photos \
PIXHELF_PORT=8080 \
docker compose up -d
```

镜像地址为 `git.pixhelf.com/adminroot/pixhelf`。发布工作流优先使用 Actions Secret
`REGISTRY_TOKEN` 和 `REGISTRY_USERNAME` 登录 Forgejo Container Registry；未配置时会尝试使用
当前工作流的临时令牌和触发用户。

推送 `master` 或在 Forgejo Actions 页面手动运行 `Build and release` 工作流时，会完整构建两种
架构并验证多架构 OCI 镜像，但不会推送镜像或创建 Release；只有推送 `v*` 标签才会正式发布。

## 参数

```text
--gallery-dir PATH     图库目录，默认 ./pic
--cache-dir PATH       缩略图缓存，默认 ./.pixhelf-cache/thumbnails
--listen HOST:PORT     监听地址，默认 0.0.0.0:3002
--initial-batch N      启动前生成数量，默认 60
--workers N            后台压缩并发数，默认按 CPU 自动选择 2-4
--scan-interval SEC    图库重新扫描间隔，默认 10 秒
```

支持 JPEG、PNG 和 WebP 文件。其他文件不会进入图库索引。

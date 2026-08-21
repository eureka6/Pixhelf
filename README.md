# Pixhelf

基于 Axum 和 React 的自托管图片画廊。React 生产资源会嵌入 Rust 可执行文件，运行时只需要一个程序文件和外部图库目录。

## 运行

默认从当前工作目录的 `./pic` 读取图片，并监听 `0.0.0.0:3002`：

```bash
./target/release/pixhelf
```

首次启动会先生成首批 60 张、最长边 720px 的 WebP 缩略图，然后开放 HTTP 服务。其余缩略图由后台任务持续处理；打开图片时，查看器会按需生成独立的最长边 2560px WebP 预览。新增、修改或删除图片会在定期扫描后自动同步。

缩略图和查看器预览缓存在 `./.pixhelf-cache/thumbnails` 下的版本化目录，原图不会被修改。

## 构建

需要当前稳定版 Rust、Node.js 20+ 和 npm：

```bash
cd frontend
npm ci
cd ..
cargo build --release
```

`cargo build` 会自动执行 React 生产构建，并将结果嵌入 `target/release/pixhelf`。

## 参数

```text
--gallery-dir PATH     图库目录，默认 ./pic
--cache-dir PATH       缩略图和查看器预览缓存，默认 ./.pixhelf-cache/thumbnails
--listen HOST:PORT     监听地址，默认 0.0.0.0:3002
--initial-batch N      启动前生成数量，默认 60
--workers N            后台压缩并发数，默认按 CPU 自动选择 2-4
--scan-interval SEC    图库重新扫描间隔，默认 10 秒
```

支持 JPEG、PNG 和 WebP 文件。其他文件不会进入图库索引。

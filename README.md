# Pixhelf

Pixhelf 是一个给自己的照片目录准备的轻量画廊。把图片放进文件夹，启动服务，
就能在浏览器里按相册浏览、搜索和排序；手机和桌面都能舒服地看图。

它支持 JPEG、PNG 和 WebP，会自动留意图库变化，并在后台生成 WebP 缩略图。
原图始终只读，缓存单独存放。Preact 前端会直接嵌进 Rust 程序里，部署时不用
再带一套静态文件。

## 用 Docker 跑起来

镜像放在 [eureka6688/pixhelf](https://hub.docker.com/r/eureka6688/pixhelf)。
在项目目录里执行：

```bash
mkdir -p pic
docker compose up -d
```

把图片放进 `./pic`，然后打开 <http://localhost:3002>。

`compose.yml` 直接使用 `eureka6688/pixhelf:latest`，图库以只读方式挂载，
生成的缩略图则保存在 `pixhelf-cache` 命名卷里。

## 自己构建

想从源码构建，需要稳定版 Rust、Node.js 20+ 和 npm：

```bash
cd frontend
npm ci
cd ..
cargo build --release --locked
```

这一步会先构建 Preact 前端，再把资源嵌入 `target/release/pixhelf`。
最终运行这一个文件就够了。

发布版本也提供两个静态可执行文件，按机器架构选择即可：

- `pixhelf-amd64-linux`
- `pixhelf-arm64-linux`

下载后记得添加执行权限：

```bash
chmod +x pixhelf-amd64-linux
```

## 可调参数

大多数时候默认值就够用。需要更换目录、端口或扫描频率时，可以使用：

```text
--gallery-dir PATH     图库目录，默认 ./pic
--cache-dir PATH       缩略图缓存，默认 ./.pixhelf-cache/thumbnails
--listen HOST:PORT     监听地址，默认 0.0.0.0:3002
--initial-batch N      启动时优先生成数量，默认 60
--workers N            后台任务数，默认按 CPU 自动选择 2-4
--scan-interval SEC    图库扫描周期，默认 10 秒
-h, --help             显示帮助
```

启动前请确认图库目录已经存在，也别把缓存目录放进图库里。

# Pixhelf

一个面向大型本地图片库的低资源 Rust 图片画廊。原图留在磁盘，SQLite 只保存元数据；列表使用游标分页，缩略图首次访问时生成并长期缓存。

Cargo 包名和构建生成的可执行文件名均为 `pixhelf`。

## 启动

```bash
mkdir -p pictures
# 将 jpg/png/webp/gif/avif 图片放入 pictures（支持子目录）
cargo run --release
```

浏览器打开 `http://127.0.0.1:3002`。也可以指定目录和监听地址：

```bash
cargo run --release -- --root /mnt/photos --data /var/lib/gallery --bind 0.0.0.0:3000
```

对应环境变量为 `GALLERY_ROOT`、`GALLERY_DATA`、`GALLERY_BIND`。程序会按容器或系统实际
可用 CPU 自动设置异步运行时、扫描和缩略图线程数；可分别通过 `--worker-threads`、
`--scan-threads`、`--thumbnail-threads` 调整，或使用 `GALLERY_WORKER_THREADS`、
`GALLERY_SCAN_THREADS`、`GALLERY_THUMBNAIL_THREADS`。值为 `0` 时保持自动配置。
Web 服务会立即开放：空数据库先提交 80 张首屏批次，再用最多 2000 张的大批次在后台补齐；
已有索引时直接显示旧索引，并在后台检查变化。
日志级别可用 `RUST_LOG=info` 调整。

## Docker

镜像使用 Alpine runtime，二进制按 musl 目标构建：

```bash
docker build -t eureka6688/pixhelf:latest .
```

本地构建 `amd64` 和 `arm64` 多架构 Alpine 镜像并推送 `latest` 与一个可回退版本号：

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --target runtime \
  --tag eureka6688/pixhelf:latest \
  --tag eureka6688/pixhelf:0.1.0 \
  --push .
```

推送到 `main` 时，GitHub Actions 会自动构建并推送 `linux/amd64` 和 `linux/arm64`
多架构镜像，只更新 `latest`。推送版本标签时还会同时发布完整版本号，例如 `0.1.0`，
用于固定版本和回退。两个标签都指向同一套 Alpine + MUSL runtime 镜像，并作为
manifest list 发布；Docker 会根据主机架构自动拉取正确的镜像：

GitHub 会把 amd64 和 arm64 构建分配给对应架构的原生 Runner，分别推送镜像 digest 后再
合并 manifest，不使用 QEMU 模拟编译。

```bash
docker pull eureka6688/pixhelf:latest
```

自动推送需要在 GitHub 仓库的 Actions secrets 中配置：

- `DOCKERHUB_USERNAME`：Docker Hub 用户名
- `DOCKERHUB_TOKEN`：具有 `eureka6688/pixhelf` 读写权限的 Docker Hub access token

```bash
docker run -d --name gallery \
  -p 3002:3002 \
  -v /path/to/photos:/pictures:ro \
  -v gallery-data:/data \
  eureka6688/pixhelf:latest
```

容器默认监听 `0.0.0.0:3002`。原图目录建议只读挂载，索引和缩略图写入 `gallery-data` 卷。

也可以使用 Docker Compose 一键部署或更新：

```bash
docker compose up -d --pull always
```

默认读取当前目录的 `pictures`，并监听主机的 `3002` 端口。可通过环境变量覆盖：

```bash
GALLERY_PICTURES=/path/to/photos GALLERY_PORT=3002 docker compose up -d --pull always
```

停止服务但保留索引和缩略图使用 `docker compose down`；连同 `gallery-data` 持久卷一起删除则使用 `docker compose down -v`。

## 发布 Linux 二进制

推送以 `v` 开头、且与 `Cargo.toml` 中版本一致的标签后，GitHub Actions 会自动构建并发布
两个完全静态链接、可直接下载的 MUSL 二进制程序：

- `pixhelf-x86_64-unknown-linux-musl`
- `pixhelf-aarch64-unknown-linux-musl`
- `SHA256SUMS`

例如发布 `0.1.2`：

```bash
git tag v0.1.2
git push origin v0.1.2
```

下载适合处理器架构的程序后，添加执行权限即可运行：

```bash
chmod +x pixhelf-x86_64-unknown-linux-musl
./pixhelf-x86_64-unknown-linux-musl --help
```

MUSL 静态二进制不依赖目标系统安装 glibc 或其他动态库，因此可覆盖大多数使用
`x86_64/amd64` 或 `aarch64/arm64` 的 64 位 Linux 发行版，包括 Alpine 和常见 glibc
发行版。它仍然是 Linux ELF 程序，不能直接用于 Windows、macOS、BSD 或 Android；
32 位设备、其他 CPU 架构以及过旧的 Linux 内核也不在这两个构建的覆盖范围内。

## 设计边界

- 启动和右上角刷新会增量写入索引；查询每批最多 100 条。
- 扫描按目录和文件名深度优先、确定性排序；冷启动首批 80 张，之后相邻目录会合并为最多
  2000 张的有序批次。批内使用多线程读取图片头，整批完成后再按原顺序写入。扫描开始时会
  一次性加载已有文件元数据到只读内存索引，避免每张图片争用 SQLite。
- 只有完整遍历成功后才会清理磁盘上已经消失的图片记录；扫描失败或已建立索引的图片目录
  暂时为空时会保留旧索引，避免存储临时离线导致索引被误删。
- 普通列表按扫描 ID 升序分页，后台提交的新批次只会追加到现有页面，不会触发全量刷新或
  把浏览位置拉回顶部；只有扫描确认磁盘文件已经删除时，前端才会同步重建当前列表。
- 交互式命令行会用一行中文进度原地显示已检查、已收录、更新数量和速度；
  Docker 等非交互日志环境每 30 秒记录一次里程碑，结束时再汇总，避免刷屏。
- 顶部路径按钮可按文件夹树筛选，选择父目录时会包含全部子目录图片。
- 文件夹树使用扫描时同步维护的独立目录索引；打开菜单只读取目录记录，不会重新遍历全部图片。
- 缩略图缓存名使用图片相对路径的稳定哈希，不依赖数据库 ID；原图变化时会覆盖同一个缓存文件。
- 程序运行时会在后台低优先级补齐 720px WebP 缩略图缓存；可见图片按需优先生成，缩略图
  并发按可用 CPU 自动设为 1–3 路。后台任务仅在全部生成槽空闲时工作，并分批读取索引，
  避免冷启动时集中解码原图或长时间占用数据库。
- 大图查看器首次打开会预取默认前进方向 3 张、反方向 2 张原图；翻页后只补当前方向的 3 张，
  反方向复用已有缓存，并取消超出附近窗口且尚未完成的请求。
- 原图响应直接从文件流输出，不整张读入服务进程内存。
- 当前版本适合单机只读图库；公网部署前应在反向代理层增加认证和 HTTPS。

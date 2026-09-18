# Pixhelf

一隅光影，满架时光。

轻量、自托管的图片与视频画廊，支持相册浏览、中文自然语言搜索、以图搜图、实况照片和原文件下载。

## Docker 部署（推荐）

支持 Linux amd64 / arm64，镜像内置搜索模型与视频组件。将以下内容保存为 [`compose.yml`](compose.yml)：

```yaml
services:
  pixhelf:
    image: eureka6688/pixhelf:latest
    restart: unless-stopped
    ports:
      - "3002:3002"
    volumes:
      - "./pic:/data/pic:ro"
      - pixhelf-data:/data/.pixhelf-data

volumes:
  pixhelf-data:
```

```bash
mkdir -p pic
docker compose up -d
```

把图片或视频放入 `pic`，或将 `./pic` 换成已有媒体目录。打开 `http://服务器地址:3002`，首次访问时创建管理员账号，密码至少 15 个字符。

程序自动索引媒体并检测目录变化，索引完成后即可使用自然语言搜索。公网访问建议使用 HTTPS 反向代理。

## 使用与设置

- **图片与相册**：按文件夹浏览，点击查看大图；右键或长按可查看信息、查找相似图片或下载原图。
- **视频**：支持常见视频格式、悬停预览、选集、倍速与全屏播放。首次播放需等待后台准备，原文件保持不变。
- **实况照片**：支持 JPEG、PNG、WebP 与同名 MOV／MP4／M4V 配对，以及 Google／Samsung 二合一 JPG。桌面悬停播放，手机轻点预览、再次轻点打开。HEIC／HEIF 照片需先转为 JPEG。
- **搜索**：支持文件名、中文描述和以图搜图；侧栏“相似图片”可上传不超过 20 MB 的 JPG、PNG、WebP。
- **账号与访客**：设置中可修改账号密码，或开启默认关闭的“免登录浏览”，允许访客浏览、搜索和下载。
- **外部存储**：在设置中连接 OpenList，即可浏览、预览和下载远程文件。

## 更新与数据

```bash
docker compose pull
docker compose up -d
```

`pixhelf-data` 卷保存索引、缩略图、视频缓存、账号与设置，请保留并备份。`docker compose down -v` 会删除此卷。

<details>
<summary>从旧的 pixhelf-cache 升级</summary>

运行 `docker volume ls` 确认原卷名，将 Compose 底部的卷声明改为：

```yaml
volumes:
  pixhelf-data:
    external: true
    name: 原项目名_pixhelf-cache
```

替换为实际旧卷名后执行 `docker compose up -d`，即可保留原有账号与数据。

</details>

## 可选配置

按需在 Compose 服务中添加 `environment`，完整参数可通过 `docker compose exec pixhelf /pixhelf --help` 查看。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PIXHELF_TEXT_SEARCH_MODEL` | 镜像内置模型 | 设为 `false` 关闭自然语言搜索 |
| `PIXHELF_WORKERS` | 自动选择 2–4 | 缩略图处理并发数，范围 1–16 |
| `PIXHELF_SCAN_INTERVAL` | `10` | 媒体目录扫描间隔，单位秒 |

## 源码运行

需要 Rust stable、Node.js 22+、npm 和 FFmpeg（`ffmpeg`、`ffprobe`，含 H.264 / AAC 编码支持）。首次构建需联网下载播放器资源。

```bash
npm --prefix frontend ci
cargo build --release
./target/release/pixhelf --gallery-dir /path/to/photos
```

前端随 Cargo 构建并嵌入程序。默认数据目录为 `./.pixhelf-data/thumbnails`，可通过 `--cache-dir` 指定；搜索模型会自动下载，可加 `--text-search-model false` 关闭。

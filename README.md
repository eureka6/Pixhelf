# Pixhelf

Pixhelf 是一个轻量、自托管的本地图片画廊，支持 JPEG、PNG 和 WebP。提供相册与瀑布流浏览、文件名和中文自然语言搜索、相似图片、随机探索、原图查看下载，以及 EXIF 和直方图。

## Docker 部署（推荐）

镜像支持 Linux amd64 和 arm64，内置文字搜图模型，无需单独下载或挂载。

安装 Docker 和 Compose 插件后，在部署目录使用以下 [`compose.yml`](compose.yml)：

```yaml
services:
  pixhelf:
    image: eureka6688/pixhelf:latest
    restart: unless-stopped
    ports:
      - "3002:3002"
    volumes:
      - "./pic:/data/pic:ro"
      - pixhelf-cache:/data/.pixhelf-cache

volumes:
  pixhelf-cache:
```

启动服务：

```bash
mkdir -p pic
docker compose up -d
```

访问 <http://localhost:3002>，将图片放入 `./pic` 即可，目录变化默认每 10 秒自动检测。

- `./pic:/data/pic:ro`：只读挂载图片目录，可将 `./pic` 改为实际路径，如 `/mnt/photos`。
- `pixhelf-cache`：自动创建的缓存卷，保留缩略图和搜索索引，避免重建容器后重新处理。

首次启动会在后台建立索引；完成前支持文件名搜索，完成后启用自然语言搜索。图片处理和搜索均在本机进行。

应用没有内置登录认证，公网访问请使用带认证的反向代理。

### 更新

```bash
docker compose pull
docker compose up -d
```

`latest` 对应最新稳定版，固定版本可使用 `eureka6688/pixhelf:0.2.5`。模型未变更时，更新可复用已有模型层。

### Docker Run

不使用 Compose 时，可以直接运行：

```bash
mkdir -p pic
docker run -d \
  --name pixhelf \
  --restart unless-stopped \
  -p 3002:3002 \
  -v "$PWD/pic:/data/pic:ro" \
  -v pixhelf-cache:/data/.pixhelf-cache \
  eureka6688/pixhelf:latest
```

## 可选配置

在 Compose 服务中添加 `environment`，修改后执行 `docker compose up -d` 生效：

```yaml
services:
  pixhelf:
    environment:
      PIXHELF_WORKERS: "4"
      PIXHELF_SCAN_INTERVAL: "30"
```

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PIXHELF_WORKERS` | 自动选择 2–4 | 后台缩略图任务数，可设为 1–16 |
| `PIXHELF_SCAN_INTERVAL` | `10` | 目录检测间隔，单位秒，可设为 2–3600 |
| `PIXHELF_TEXT_SEARCH_MODEL` | 内置模型 | 设为 `"false"` 关闭自然语言搜索，保留文件名搜索和相似图片 |

完整参数可通过 `docker compose exec pixhelf /pixhelf --help` 查看。

## 其他运行方式

### 独立程序

从 [Releases](https://git.pixhelf.com/adminroot/pixhelf/releases) 下载对应架构的程序，以 amd64 为例：

```bash
chmod +x pixhelf-amd64-linux
./pixhelf-amd64-linux \
  --gallery-dir /path/to/photos \
  --cache-dir /path/to/pixhelf-cache
```

独立程序默认会在后台下载文字搜图模型（约 753 MB），可加 `--text-search-model false` 关闭。

### 源码运行

需要 Rust stable、Node.js 22 和 npm：

```bash
npm --prefix frontend ci
cargo run --release -- \
  --gallery-dir /path/to/photos \
  --cache-dir /path/to/pixhelf-cache
```

前端会随 Cargo 构建并嵌入可执行文件。

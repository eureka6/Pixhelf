# Pixhelf

Pixhelf 是一个轻量、自托管的本地照片画廊。它递归读取照片目录，在浏览器中提供相册导航、瀑布流浏览、自然语言文字搜图、本地以图搜图、随机探索、原图查看与下载，以及 EXIF 和直方图信息。

- 支持 JPEG、PNG 和 WebP
- 自动发现目录变化，无需手工刷新索引
- 图片、缩略图、搜索与相似度计算均在本机完成
- 官方 Docker 镜像内置 Chinese-CLIP 模型，启动时无需访问 Hugging Face
- 支持 Linux amd64 和 arm64

## 快速开始

推荐使用 Docker Compose。项目提供的 [`compose.yml`](compose.yml) 等价于以下配置：

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

把照片放进 `./pic`，然后访问 <http://localhost:3002>。Pixhelf 每 10 秒检查一次目录变化，新照片会自动出现。

Pixhelf 当前不提供内置身份认证。不要直接暴露到公网；需要远程访问时，请在可信网络中使用，或在前面配置带身份认证的反向代理。

### 挂载说明

| 挂载 | 用途 | 是否必需 |
| --- | --- | --- |
| `./pic:/data/pic:ro` | 让容器只读访问宿主机照片 | 必需，可将 `./pic` 改为实际照片目录 |
| `pixhelf-cache:/data/.pixhelf-cache` | 保存缩略图、相似度特征和文字搜索索引 | 推荐，由 Compose 自动创建，无需准备宿主机目录 |
| 模型目录 | 无 | 不需要，模型已包含在镜像中 |

如果不需要保留缓存，可以删除 `pixhelf-cache` 挂载和顶层 `volumes` 段；容器重建后会重新生成全部缓存。

使用其他照片目录时，只需修改第一项挂载，例如：

```yaml
volumes:
  - "/mnt/photos:/data/pic:ro"
  - pixhelf-cache:/data/.pixhelf-cache
```

### 更新

```bash
docker compose pull
docker compose up -d
```

模型位于独立的压缩 OCI 层中。第一次拉取会下载模型；后续更新只要模型版本不变，Docker 就会复用本地模型层，只下载新的应用层。amd64 与 arm64 镜像共享同一模型层。

镜像只发布版本号与 `latest` 两类标签。使用 `latest` 自动跟随稳定版本；需要固定版本时使用 `eureka6688/pixhelf:0.2.3`。带 `v` 的标签仅用于 Git 和 Forgejo Release。

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

## 使用

1. 左侧相册栏按照片目录组织内容，并显示缩略图和文字索引的处理进度。
2. 右上角搜索支持文件名搜索；文字索引完成后会自动切换为中文自然语言搜索。
3. 随机探索按钮会从当前图库中换一组照片。
4. 打开照片后可以缩放、拖动、切换上一张或下一张、下载原图或进入全屏。
5. 向下滚动查看文件信息、拍摄参数、RGB/亮度直方图和相似图片；以图搜图完全在本机运行，不依赖模型。

图片查看器支持以下键盘操作：

| 按键 | 操作 |
| --- | --- |
| `←` / `→` | 上一张 / 下一张 |
| `+` / `-` | 放大 / 缩小 |
| `0` | 恢复适应窗口 |
| `↓` / `PageDown` | 前往图片详情 |
| `↑` / `PageUp` | 返回图片 |
| `Esc` | 关闭查看器；全屏时先退出全屏 |

## 配置

Docker 用户可在 Compose 的 `environment` 中覆盖参数：

```yaml
services:
  pixhelf:
    environment:
      PIXHELF_WORKERS: "4"
      PIXHELF_SCAN_INTERVAL: "30"
```

命令行参数的优先级高于对应环境变量。

| 环境变量 | 命令行参数 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `PIXHELF_GALLERY_DIR` | `--gallery-dir PATH` | `./pic` | 图库根目录 |
| `PIXHELF_CACHE_DIR` | `--cache-dir PATH` | `./.pixhelf-cache/thumbnails` | 缩略图和搜索缓存目录，必须位于图库外部 |
| `PIXHELF_TEXT_SEARCH_MODEL` | `--text-search-model VALUE` | Docker 使用内置模型；独立二进制为 `true` | `true` 自动下载，`false` 关闭，也可指定模型目录或文件 |
| `PIXHELF_TEXT_SEARCH_VOCAB` | `--text-search-vocab PATH` | 模型同目录的 `vocab.txt` | 可选词表覆盖路径 |
| `PIXHELF_LISTEN` | `--listen HOST:PORT` | `0.0.0.0:3002` | 监听地址 |
| `PIXHELF_INITIAL_BATCH` | `--initial-batch N` | `60` | 优先生成的首批缩略图数量，范围 `1`–`500` |
| `PIXHELF_WORKERS` | `--workers N` | 根据 CPU 自动选择 `2`–`4` | 后台缩略图任务数，范围 `1`–`16` |
| `PIXHELF_SCAN_INTERVAL` | `--scan-interval SEC` | `10` | 图库检查间隔，范围 `2`–`3600` 秒 |

查看完整命令行帮助：

```bash
pixhelf --help
```

## 自然语言文字搜图

Chinese-CLIP ViT-B/16 支持直接输入中文描述，例如“海边日落”“草地上的狗”或“夜晚城市街道”。索引尚未完成时，搜索框仍按文件名工作；完成后自动切换到语义搜索，并优先保留文件名精确匹配。

官方 Docker 镜像已经包含经过校验的固定模型与词表，容器启动后不会访问 Hugging Face。模型权重按需加载，连续空闲 60 秒后自动释放。512 维图片向量按模型与词表指纹保存在缓存卷中，每张约 552 字节。

关闭文字搜图：

```yaml
services:
  pixhelf:
    environment:
      PIXHELF_TEXT_SEARCH_MODEL: "false"
```

离线环境也可以通过 `PIXHELF_TEXT_SEARCH_MODEL` 指定同时包含 `model.safetensors` 和 `vocab.txt` 的目录。仅当词表位于其他位置时，才需要设置 `PIXHELF_TEXT_SEARCH_VOCAB`。

## 独立二进制

[Forgejo Releases](https://git.pixhelf.com/adminroot/pixhelf/releases) 提供静态链接的 Linux amd64 与 arm64 二进制。下载匹配架构的文件后运行：

```bash
chmod +x pixhelf-amd64-linux
./pixhelf-amd64-linux \
  --gallery-dir /path/to/photos \
  --cache-dir /path/to/pixhelf-cache
```

独立二进制默认在后台从 Hugging Face 的 OFA-Sys 官方仓库下载并校验模型，约 753 MB。Web 服务会立即启动并先提供文件名搜索；下载支持断点续传和后台重试，完成后自动启用语义搜索。后续启动会复用缓存。

## 从源码运行

需要 Rust stable、Node.js 22 和 npm：

```bash
cd frontend
npm ci
cd ..
cargo run --release -- \
  --gallery-dir /path/to/photos \
  --cache-dir /path/to/pixhelf-cache
```

前端会在 Cargo 构建期间编译并嵌入可执行文件。

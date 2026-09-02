# Pixhelf

轻量的本地照片画廊，支持 JPEG、PNG、WebP、照片直方图与 EXIF、自然语言文字搜图、随机探索和本地以图搜图。相似图片会直接显示在图片查看器下方的分页瀑布流中。

## Docker Compose

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

模型已经包含在镜像中，不需要挂载模型目录。这里只需把宿主机的 `./pic` 照片目录只读挂载到容器；`pixhelf-cache` 是 Compose 自动创建和管理的命名卷，无需手工准备路径，用来在容器更新后继续复用缩略图和搜索索引。

如果不需要保留缓存，可以删除 `pixhelf-cache:/data/.pixhelf-cache` 和末尾的 `volumes` 段；容器重建后会重新生成缩略图与搜索索引。

```bash
mkdir -p pic
docker compose up -d
```

## Docker

```bash
mkdir -p pic && docker run -d --name pixhelf --restart unless-stopped -p 3002:3002 -v "$PWD/pic:/data/pic:ro" -v pixhelf-cache:/data/.pixhelf-cache eureka6688/pixhelf:latest
```

照片放进 `./pic`，访问 <http://localhost:3002>。

镜像发布只使用版本号标签（例如 `0.2.3`）和 `latest`；带 `v` 的标签只用于 Git 与 Forgejo Release，不再重复发布为镜像标签。

### Compose 参数配置

Pixhelf 参数可以直接通过 Compose 的 `environment` 配置，无需编写 `command`：

```yaml
services:
  pixhelf:
    environment:
      PIXHELF_INITIAL_BATCH: "100"
      PIXHELF_WORKERS: "4"
      PIXHELF_SCAN_INTERVAL: "30"
```

支持的环境变量如下；命令行参数的优先级高于环境变量。

| 环境变量 | 对应命令行参数 | 默认值 |
| --- | --- | --- |
| `PIXHELF_GALLERY_DIR` | `--gallery-dir` | `./pic` |
| `PIXHELF_CACHE_DIR` | `--cache-dir` | `./.pixhelf-cache/thumbnails` |
| `PIXHELF_TEXT_SEARCH_MODEL` | `--text-search-model` | Docker 镜像使用内置模型；独立二进制为 `true` 并自动下载；`false` 关闭，也可填写模型目录或文件 |
| `PIXHELF_TEXT_SEARCH_VOCAB` | `--text-search-vocab` | 可选覆盖；默认读取模型目录的 `vocab.txt` |
| `PIXHELF_LISTEN` | `--listen` | `0.0.0.0:3002` |
| `PIXHELF_INITIAL_BATCH` | `--initial-batch` | `60` |
| `PIXHELF_WORKERS` | `--workers` | 根据 CPU 自动选择 `2`–`4` |
| `PIXHELF_SCAN_INTERVAL` | `--scan-interval` | `10` 秒 |

## 自然语言文字搜图

可选的 Chinese-CLIP ViT-B/16 模型支持直接输入中文描述，例如“海边日落”“草地上的狗”或“夜晚城市街道”。图片与文字编码都在本机完成。索引尚未完成时搜索框仍按文件名搜索；完成后自动切换到语义搜索，并保留文件名精确匹配优先级。

语义搜索默认启用，Compose 无需增加模型参数。需要关闭时设置：

```yaml
services:
  pixhelf:
    environment:
      PIXHELF_TEXT_SEARCH_MODEL: "false"
```

命令行同样可以关闭：

```bash
pixhelf --text-search-model false
```

官方 Docker 镜像已经包含校验过的固定版本模型与词表，不会在容器启动后访问 Hugging Face。模型位于独立、可复现的压缩 OCI 基础层中：第一次 `docker pull` 会下载该层；以后更新 Pixhelf 时，只要模型版本不变，Docker 会按内容摘要复用本地层，只拉取新的应用层。amd64 与 arm64 镜像也共享同一份模型层。缩略图与搜索索引仍保存在 `pixhelf-cache` 卷中。

直接运行独立二进制时仍会在首次启动后从 Hugging Face 的 OFA-Sys 官方仓库后台下载并校验模型（约 753 MB）。Web 服务无需等待模型，先以文件名搜索正常启动；下载支持断点续传和后台重试，后续启动复用缓存，无需重复下载。

离线环境仍可手动提供包含 `model.safetensors` 和 `vocab.txt` 的目录。原来的模型文件路径也继续兼容；仅当词表不在模型同目录时，才需要额外配置 `PIXHELF_TEXT_SEARCH_VOCAB` 或 `--text-search-vocab`。

文字搜图使用一个 CPU 后台任务建立 512 维图像索引，向量按模型与词表指纹保存在缩略图缓存中，每张约 552 字节。模型权重按需载入内存：已有完整向量缓存时启动不会载入，只有补建索引或执行新的文字查询时才载入；连续空闲 60 秒后自动释放，下次需要时再载入。侧边栏会显示“文字索引”进度；更换模型文件前请先停止 Pixhelf。

## 本地以图搜图

以图搜图不需要模型：相似度完全在本机计算，综合比较图片的构图、亮度、色彩分布、边缘纹理和感知哈希，并过滤明显无关的结果。特征描述符会保存在缩略图缓存卷中；升级已有图库时会在后台自动补齐，之后重启无需重新计算。

## 照片直方图与 EXIF

在图片查看器中向下滚动即可查看 RGB/亮度直方图、文件大小与修改时间，以及拍摄时间、相机、镜头、快门、光圈、ISO、焦距等常用 EXIF 信息。数据仅在打开查看器时按需读取并缓存在内存中；直方图复用已有缩略图，不会在图库扫描阶段批量解码原图。

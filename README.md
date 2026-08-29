# Pixhelf

轻量的本地照片画廊，支持 JPEG、PNG、WebP、自然语言文字搜图、随机探索和本地以图搜图。相似图片会直接显示在图片查看器下方的分页瀑布流中。

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

```bash
mkdir -p pic
docker compose up -d
```

## Docker

```bash
mkdir -p pic && docker run -d --name pixhelf --restart unless-stopped -p 3002:3002 -v "$PWD/pic:/data/pic:ro" -v pixhelf-cache:/data/.pixhelf-cache eureka6688/pixhelf:latest
```

照片放进 `./pic`，访问 <http://localhost:3002>。

## 自然语言文字搜图

可选的 Chinese-CLIP ViT-B/16 模型支持直接输入中文描述，例如“海边日落”“草地上的狗”或“夜晚城市街道”。图片与文字都在本机编码，Pixhelf 不会在运行时联网或自动下载模型。索引尚未完成时搜索框仍按文件名搜索；完成后自动切换到语义搜索，并保留文件名精确匹配优先级。

下载并校验固定版本的官方模型与词表（模型约 753 MB）：

```bash
mkdir -p models/chinese-clip
curl --proto '=https' --tlsv1.2 --fail --location \
  https://huggingface.co/OFA-Sys/chinese-clip-vit-base-patch16/resolve/f4a64596bbcf9a2a94591b74b9dc39b2e4e77e3e/model.safetensors \
  --output models/chinese-clip/model.safetensors
curl --proto '=https' --tlsv1.2 --fail --location \
  https://huggingface.co/OFA-Sys/chinese-clip-vit-base-patch16/resolve/f4a64596bbcf9a2a94591b74b9dc39b2e4e77e3e/vocab.txt \
  --output models/chinese-clip/vocab.txt
printf '%s  %s\n%s  %s\n' \
  29cc0b2bcf6ff777f2e15742be92b110e4acbdb2068356e862c4637a4b15fe4f \
  models/chinese-clip/model.safetensors \
  45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c \
  models/chinese-clip/vocab.txt | sha256sum --check -
```

Compose 服务增加模型目录挂载与启动参数：

```yaml
services:
  pixhelf:
    volumes:
      - "./pic:/data/pic:ro"
      - pixhelf-cache:/data/.pixhelf-cache
      - "./models/chinese-clip:/models/chinese-clip:ro"
    command:
      - "--text-search-model"
      - "/models/chinese-clip/model.safetensors"
      - "--text-search-vocab"
      - "/models/chinese-clip/vocab.txt"
```

本地运行：

```bash
pixhelf \
  --text-search-model ./models/chinese-clip/model.safetensors \
  --text-search-vocab ./models/chinese-clip/vocab.txt
```

文字搜图使用一个 CPU 后台任务建立 512 维图像索引，向量按模型与词表指纹保存在缩略图缓存中，每张约 552 字节。侧边栏会显示“文字索引”进度；更换模型文件前请先停止 Pixhelf。

## 本地以图搜图

默认模式不需要模型：相似度完全在本机计算，综合比较图片的构图、亮度、色彩分布和边缘纹理，并过滤明显无关的结果。特征描述符会保存在缩略图缓存卷中；升级已有图库时会在后台自动补齐，之后重启无需重新计算。

如果希望识别“主体相近、构图和颜色不同”的图片，可以选择挂载 Meta 的 DINOv2 Small 官方权重。Pixhelf 不会联网或自动下载模型；开启后会用一个 CPU 后台任务建立 384 维语义索引，再与默认视觉特征混合排序。模型缺失或单张图片推理失败时会自动使用默认算法。

先在宿主机下载并校验固定版本的模型（88.2 MB，Apache-2.0）：

```bash
mkdir -p models
curl --proto '=https' --tlsv1.2 --fail --location \
  https://huggingface.co/facebook/dinov2-small/resolve/ed25f3a31f01632728cabb09d1542f84ab7b0056/model.safetensors \
  --output models/dinov2-small.safetensors
printf '%s  %s\n' \
  ae1e99fcefd534ed978cdeb8326f08030c96e28b7a81ffcbc98a857c84d14be1 \
  models/dinov2-small.safetensors | sha256sum --check -
```

然后在 Compose 服务中增加只读挂载和启动参数：

```yaml
services:
  pixhelf:
    volumes:
      - "./pic:/data/pic:ro"
      - pixhelf-cache:/data/.pixhelf-cache
      - "./models/dinov2-small.safetensors:/models/dinov2-small.safetensors:ro"
    command: ["--semantic-model", "/models/dinov2-small.safetensors"]
```

本地运行时使用同一个参数：

```bash
pixhelf --semantic-model ./models/dinov2-small.safetensors
```

语义向量按模型指纹保存在缩略图缓存中，每张约 424 字节；侧边栏会显示“语义索引”进度。更换模型文件前请先停止 Pixhelf，替换后再启动。

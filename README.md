# 暮色画廊 / Lowkey Gallery

一个面向大型本地图片库的低资源 Rust 图片画廊。原图留在磁盘，SQLite 只保存元数据；列表使用游标分页，缩略图首次访问时生成并长期缓存。

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

对应环境变量为 `GALLERY_ROOT`、`GALLERY_DATA`、`GALLERY_BIND`。日志级别可用 `RUST_LOG=info` 调整。

## Docker

镜像使用 Alpine runtime，二进制按 musl 目标构建：

```bash
docker build -t eureka6688/gallery:latest .
```

构建当前处理器架构的 Alpine 镜像：

```bash
VERSION=0.1.0 docker buildx bake
```

默认只构建 `linux/amd64`。构建 `amd64` 和 `arm64` 多架构 Alpine 镜像并推送到仓库：

```bash
VERSION=0.1.0 PLATFORMS=linux/amd64,linux/arm64 docker buildx bake --push
```

生成的标签包括 `latest`、版本号、以及带运行时后缀的版本标签，例如 `0.1.0`、`0.1.0-alpine` 和 `0.1.0-musl`。这些标签指向同一套 Alpine runtime 镜像；多架构发布时会成为 manifest list。

```bash
docker run -d --name gallery \
  -p 3002:3002 \
  -v /path/to/photos:/pictures:ro \
  -v gallery-data:/data \
  eureka6688/gallery:latest
```

容器默认监听 `0.0.0.0:3002`。原图目录建议只读挂载，索引和缩略图写入 `gallery-data` 卷。

## 设计边界

- 启动和右上角刷新会增量写入索引；查询每批最多 100 条。
- 顶部路径按钮可按文件夹树筛选，选择父目录时会包含全部子目录图片。
- 程序运行时会在后台自动补齐 720px WebP 缩略图缓存，首次访问尚未生成的图片时也会即时生成。
- 原图响应直接从文件流输出，不整张读入服务进程内存。
- 当前版本适合单机只读图库；公网部署前应在反向代理层增加认证和 HTTPS。

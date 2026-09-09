# Pixhelf

一隅光影，满架时光。

轻量、自托管的图片画廊，支持 JPEG、PNG、WebP，相册与 Justified 布局、中文自然语言搜索、以图搜图、随机探索，以及原图下载、EXIF 和直方图。

## Docker 部署（推荐）

镜像支持 Linux amd64 / arm64，内置文字搜图模型。将以下内容保存为 [`compose.yml`](compose.yml)：

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

把图片放入 `pic`，或将 `./pic` 换成已有图片目录。打开 `http://服务器地址:3002`，创建管理员账号并设置至少 15 个字符的密码即可使用，无需额外配置登录环境变量。首次初始化仅能完成一次，部署后请先创建管理员。

程序自动索引图片并检测目录变化；索引期间可按文件名搜索，完成后支持自然语言搜索。公网部署建议使用 HTTPS 反向代理，代理目标为 `服务器地址:3002`，同一 Docker 网络内可用 `pixhelf:3002`；图库页面和 API 应遵循应用的缓存指令。

## 使用与设置

- **浏览图片**：点击查看大图，桌面右键或手机长按打开菜单，可查看图片信息、查找相似图片或下载原图。
- **以图搜图**：侧栏“相似图片”支持上传不超过 20 MB 的 JPG、PNG、WebP；查询图片仅用于搜索，不写入图库。
- **账号安全**：设置中可修改用户名和密码，保存后所有设备需重新登录。
- **访客模式**：默认关闭。开启“免登录浏览”后，来访者无需密码即可浏览、搜图和下载；账号设置与外部存储仅限管理员。
- **外部存储**：在设置中连接 OpenList，填写服务地址、账号密码或令牌及起始目录，即可浏览、预览和下载远程文件。

## 更新与数据

```bash
docker compose pull
docker compose up -d
docker compose logs --tail=50 -f pixhelf
```

`pixhelf-data` 卷挂载到 `/data/.pixhelf-data`，保存缩略图、索引、账号与设置。卷内 `thumbnails/auth/` 保存管理员和访客配置，`thumbnails/settings/` 保存外部存储配置。保留并备份此卷，更新或重建容器后设置仍在；`docker compose down -v` 会删除数据卷。

<details>
<summary>从旧的 pixhelf-cache 升级</summary>

先运行 `docker volume ls` 确认原卷名。将新 Compose 底部的卷声明改为以下形式，即可通过新名称和挂载路径复用原有账号与数据：

```yaml
volumes:
  pixhelf-data:
    external: true
    name: 原项目名_pixhelf-cache
```

将 `原项目名_pixhelf-cache` 替换为实际旧卷名，然后执行 `docker compose up -d`。如需同时更换实际卷名，先停服并将旧卷完整复制到新卷，再使用默认 Compose。

独立运行时，先停止程序，将工作目录中的 `.pixhelf-cache` 改名为 `.pixhelf-data`；也可继续用 `--cache-dir` 或 `PIXHELF_CACHE_DIR` 指向原来的 `thumbnails` 目录。

</details>

## 可选配置

按需在 Compose 服务中添加 `environment`，其余参数可通过 `docker compose exec pixhelf /pixhelf --help` 查看。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PIXHELF_TEXT_SEARCH_MODEL` | 镜像内置模型 | 设为 `false` 关闭自然语言搜索 |
| `PIXHELF_WORKERS` | 自动选择 2–4 | 后台处理并发数，范围 1–16 |
| `PIXHELF_SCAN_INTERVAL` | `10` | 图片目录扫描间隔，单位秒 |

## 源码运行

需要 Rust stable、Node.js 22+ 和 npm。

```bash
npm --prefix frontend ci
cargo build --release
./target/release/pixhelf --gallery-dir /path/to/photos
```

前端随 Cargo 构建并嵌入程序，默认数据目录为 `./.pixhelf-data/thumbnails`，可用 `--cache-dir` 指定其他位置。独立程序会自动下载文字搜图模型，可加 `--text-search-model false` 关闭。

验证：`cargo test`；浏览器回归使用 `npm --prefix frontend run auth-check`（需先执行 `cargo build`，并安装 OpenSSL 和 Chromium）。

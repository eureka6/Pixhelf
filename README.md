# Pixhelf

一隅光影，满架时光。

轻量、自托管的图片与视频画廊，支持 JPEG、PNG、WebP 及常见视频格式，相册与 Justified 布局、中文自然语言搜索、以图搜图、随机探索，以及原文件下载、媒体信息、EXIF 和直方图。

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

把图片或视频放入 `pic`，或将 `./pic` 换成已有媒体目录。打开 `http://服务器地址:3002`，创建管理员账号并设置至少 15 个字符的密码即可使用，无需额外配置登录环境变量。首次初始化仅能完成一次，部署后请先创建管理员。

程序自动索引图片与视频并检测目录变化；索引期间可按文件名搜索，完成后支持自然语言搜索。公网部署建议使用 HTTPS 反向代理，代理目标为 `服务器地址:3002`，同一 Docker 网络内可用 `pixhelf:3002`；图库页面和 API 应遵循应用的缓存指令。

## 使用与设置

- **浏览图片**：点击查看大图，桌面右键或手机长按打开菜单，可查看图片信息、查找相似图片或下载原图。
- **浏览视频**：支持 MP4、WebM、MOV、MKV、AVI、OGV、3GP、FLV／F4V、WMV、TS／M2TS、MPG／M2V、M4V、MJPEG、MXF、RM／RMVB、SWF 视频、WTV、裸 H.264／HEVC 等格式的扫描、封面与信息读取。扫描后会像缩略图一样自动排队准备播放副本与预览，界面显示准备进度；打开视频会提升对应任务的优先级，等待完成后自动加载。播放副本为 H.264/AAC MP4，最高 1080p、30 帧，前置索引、每秒关键帧及 HTTP Range 支持浏览器原生播放和进度跳转。预览为最长 6 秒、长边最多 480 像素、24 帧的静音短片。桌面悬停预览，手机首次轻点预览、再次轻点打开播放器；同时最多预览一个。点开播放器会自动播放，后台准备中的视频会在就绪后自动开始；浏览器拦截时可轻点播放。播放界面采用顶部单行文件名与底部轻量控制条，闲置时控件自动淡出，鼠标移动或手机轻点可唤回；画面保持完整，控件不会随悬停挤动。视频、详情与相似内容在同一页面连续滚动，支持鼠标滚轮和画面中间的手机滑动，相似结果触底继续加载；离开视频区域会暂停并保留进度，可随时返回播放。桌面右键或手机长按画面打开操作菜单，可查看信息、按当前播放画面查找相似内容和下载原视频；打开菜单暂停播放，搜索结果标注取帧时间，分页与重试复用同一画面。底栏左侧按上一集、播放、下一集排列，首尾隐藏对应切集按钮；切集跳过图片。右侧依次为剧集、倍速和音量，剧集列表显示封面、标题与时长，支持直接选集。时间轴显示实际缓冲范围，悬停或拖动时按目标时间解码预览画面，不打断主视频；离开后释放预览。点击时间可输入秒数、分:秒或时:分:秒跳转。倍速可选 0.5×、0.75×、1×、1.25×、1.5×、2.0×；支持音量、浏览器支持时的画中画与全屏，切集保留全屏。桌面双击全屏与单击播放分开识别。触屏左／右双击后退／快进 10 秒，第二下按住持续后退或临时 2× 快进，松开恢复；左侧上下滑调画面亮度，右侧上下滑调音量，浮层显示图标、百分比和刻度。空格暂停／继续、方向键快进／后退、Alt + 方向键切换剧集。后台使用独立队列、一个转码任务和两个编码线程，优先处理短预览；缓存存放于数据目录，重启可复用，媒体变更或删除后自动清理，失败最多自动尝试三次，也可在播放器中重试。文件名搜索可直接查找视频，自然语言搜索和视频候选索引基于封面，播放器内的相似查询使用当前播放帧。源文件与下载内容保持原样；裸码流的原始信息可能没有时长，SWF 仅处理视频流。外部存储视频继续使用 libmedia 播放原文件。
- **浏览相册**：首页显示顶层文件夹，进入后显示直属子相册；可通过路径导航返回上层。搜索会查找所有层级，支持直接进入子相册；同名文件夹通过完整路径区分。
- **实况照片**：支持 JPEG、PNG、WebP 与同名 MOV／MP4／M4V 配对，以及 Google／Samsung 二合一 JPG。后台提取视频片段并准备浏览器可播放的静音预览，支持 HEVC 来源；预览保留最多 30 秒。桌面悬停播放，手机首次轻点播放、再次轻点打开大图；大图自动播放一遍，之后单击重播。全页面最多同时播放一个，等待时显示细进度条。照片与配对原视频不会被改写，配对视频更新会单独刷新预览缓存。HEIC／HEIF 照片暂不支持，可导出为 JPEG 并保留同名视频。
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
| `PIXHELF_WORKERS` | 自动选择 2–4 | 缩略图处理并发数，范围 1–16；视频使用独立队列 |
| `PIXHELF_SCAN_INTERVAL` | `10` | 媒体目录扫描间隔，单位秒 |

## 源码运行

需要 Rust stable、Node.js 22+ 和 npm。视频索引、封面、播放副本和实况预览需要在 PATH 中安装 FFmpeg（`ffmpeg` 与 `ffprobe`，包含 `libx264` 和 AAC 编码器）；Docker 镜像已内置。首次前端构建会下载约 67 MB 的固定版本 libmedia 解码资源，用于外部存储原视频播放，按 SHA-256 校验并缓存到 `frontend/node_modules/.cache`，缓存齐全后可离线构建。播放器脚本、分块与 Wasm 都嵌入最终程序，按需从本服务加载，不依赖第三方 CDN；本地图库的已准备视频使用浏览器原生播放器。版本及校验值记录在 `frontend/libmedia-assets.json`。

```bash
npm --prefix frontend ci
cargo build --release
./target/release/pixhelf --gallery-dir /path/to/photos
```

前端随 Cargo 构建并嵌入程序，默认数据目录为 `./.pixhelf-data/thumbnails`，可用 `--cache-dir` 指定其他位置。独立程序会自动下载文字搜图模型，可加 `--text-search-model false` 关闭。

验证：`cargo test`；浏览器回归使用 `npm --prefix frontend run auth-check`（需先执行 `cargo build`，并安装 OpenSSL 和 Chromium）。

视频验证：`cargo test video_compatibility_testset -- --ignored` 使用 `pic/pixhelf-video-testset` 对照清单验证全部视频的信息、封面和 Range 响应；可用 `PIXHELF_VIDEO_TESTSET` 指定其他测试集目录。`cargo test filesamples_video_testset -- --ignored --nocapture` 验证 `pic/video` 下载清单中的全部样本及已知空文件；可用 `PIXHELF_FILESAMPLES_TESTSET` 指定目录。`npm --prefix frontend run video-preview-check` 验证桌面悬停、手机轻点、实况与视频切换、相似结果预览和失败回退（需先构建前端）。`npm --prefix frontend run video-check` 验证桌面与手机上的播放、拖动进度、媒体切换和错误提示（需先 `cargo build` 并安装 Chromium）。`npm --prefix frontend run libmedia-formats-check` 使用 `pic/video/pine-and-birch-manifest.json` 逐个检查下载样本的画面和音轨，并确认播放没有外部资源请求；可用 `PIXHELF_PINE_SAMPLES` 指定样本目录。

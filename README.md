<div align="center">

# Pixhelf

**一隅光影，满架时光。**

基于 Rust 的自托管图片与视频画廊，支持中文自然语言搜索与以图搜图。

[![Release](https://img.shields.io/github/v/release/eureka6/Pixhelf?style=flat-square&logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI%2BPHBhdGggZmlsbD0id2hpdGUiIGZpbGwtcnVsZT0iZXZlbm9kZCIgZD0iTTEgMWg2bDggOC02IDYtOC04Wm0zIDJhMSAxIDAgMSAwIDAgMiAxIDEgMCAwIDAgMC0yWiIvPjwvc3ZnPg%3D%3D&label=Release&color=22c55e)](https://github.com/eureka6/Pixhelf/releases)
[![Docker pulls](https://img.shields.io/docker/pulls/eureka6688/pixhelf?style=flat-square&logo=docker&logoColor=white&label=Pulls)](https://hub.docker.com/r/eureka6688/pixhelf)
[![Docker image size](https://img.shields.io/docker/image-size/eureka6688/pixhelf/latest?style=flat-square&logo=docker&logoColor=white&arch=amd64&label=Image%20size)](https://hub.docker.com/r/eureka6688/pixhelf/tags)
[![Stars](https://img.shields.io/github/stars/eureka6/Pixhelf?style=flat-square&logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI%2BPHBhdGggZmlsbD0id2hpdGUiIGQ9Im04IDAgMi41IDUgNS41LjgtNCAzLjkuOSA1LjVMOCAxMi42IDMuMSAxNS4yIDQgOS43IDAgNS44IDUuNSA1WiIvPjwvc3ZnPg%3D%3D&label=Stars&color=eab308)](https://github.com/eureka6/Pixhelf)
[![Rust 1.97.1](https://img.shields.io/badge/Rust-1.97.1-000000?style=flat-square&logo=rust&logoColor=white)](./rust-toolchain.toml)

[在线演示](https://pixhelf.com/) · [使用文档](./docs/README.md) · [Docker 部署](#部署)

<img src="./readme.webp" width="960" alt="蓝天、海岸与随风飞舞的照片，Pixhelf 主题插画" />

</div>

把照片与视频放进自己的服务器，在浏览器里翻阅、搜索和整理。

- **轻松查找**：中文自然语言搜索、以图搜图。
- **统一浏览**：图片、视频、GIF 与实况照片。
- **日常整理**：相册、收藏、上传与原文件下载。
- **连接存储**：本地媒体目录与 OpenList 外部存储。

## 部署

推荐使用 **Docker Compose**，支持 Linux **amd64 / arm64**。镜像已包含搜索模型和视频组件。

### 1. 保存配置

安装好 Docker 与 Compose 插件后，在准备好的目录中创建 [`compose.yml`](./compose.yml)：

```yaml
services:
  pixhelf:
    image: eureka6688/pixhelf:latest
    restart: unless-stopped
    ports:
      - "3002:3002"
    volumes:
      - "./pic:/data/pic"
      - pixhelf-data:/data/.pixhelf-data

volumes:
  pixhelf-data:
```

将 `./pic` 换成已有照片目录，或创建空目录后再添加文件。

### 2. 启动并访问

```bash
mkdir -p pic
docker compose up -d
```

打开 `http://服务器地址:3002`，首次访问时创建管理员账号，密码至少 15 个字符。图库会在后台扫描，索引完成后即可使用中文搜索。

管理员可在页面上传文件、管理账号和连接 OpenList；需要公开浏览时，在设置中开启“免登录浏览”。公网访问建议配置 HTTPS 反向代理。

### 3. 更新与保存数据

```bash
docker compose pull
docker compose up -d
```

`pic` 保存原文件，`pixhelf-data` 卷保存账号、设置、索引和缓存，两者都应备份。更新时保留数据卷，`docker compose down -v` 会删除它。

更多配置、旧数据卷迁移和单文件部署见[部署与维护](./docs/DEPLOYMENT.md)。

## 外部代码说明

Pixhelf 使用 [Preact](https://github.com/preactjs/preact) 构建界面、[Axum](https://github.com/tokio-rs/axum) 提供服务；图标路径取自 [Lucide](https://github.com/lucide-icons/lucide)，浏览器媒体播放使用 [libmedia](https://github.com/zhaohappy/libmedia)，中文搜索使用 [Chinese-CLIP](https://github.com/OFA-Sys/Chinese-CLIP) 模型与 [Candle](https://github.com/huggingface/candle)。感谢这些项目及其贡献者。

直接引用的图标、播放器适配和内嵌 FFmpeg 等组件的来源与许可证见[外部代码与组件](./docs/THIRD_PARTY.md)。

# Pixhelf

一隅光影，满架时光。

自托管的图片与视频画廊，支持中文自然语言搜索、以图搜图、实况照片、GIF 和原文件下载，也可以连接 OpenList 浏览外部存储。

![Pixhelf 插图](./readme.png)

支持 Linux amd64 / arm64，Docker 镜像内置搜索模型与视频组件。将以下内容保存为 [`compose.yml`](./compose.yml)：

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

```bash
mkdir -p pic
docker compose up -d
```

把图片或视频放入 `pic`，也可以将 `./pic` 换成已有媒体目录。打开 `http://服务器地址:3002`，首次访问时创建管理员账号，密码至少 15 个字符。图库会在后台扫描，索引完成后即可使用自然语言搜索。

管理员可在顶栏菜单上传图片，在设置中管理账号、内容分类和 OpenList 连接。需要公开浏览时，在设置中开启“免登录浏览”。公网部署建议通过 HTTPS 反向代理访问。

更新时执行：

```bash
docker compose pull
docker compose up -d
```

`pixhelf-data` 卷保存账号、设置、索引和缓存，请保留并备份；`docker compose down -v` 会删除这个卷。原来使用 `pixhelf-cache` 的部署可以继续使用旧卷：

```yaml
volumes:
  pixhelf-data:
    external: true
    name: 原项目名_pixhelf-cache
```

需要调整配置时，在 Compose 中添加 `environment`：`PIXHELF_TEXT_SEARCH_MODEL=false` 关闭自然语言搜索，`PIXHELF_WORKERS` 设置后台并发数（1–16），`PIXHELF_SCAN_INTERVAL` 设置扫描间隔（秒）。完整参数可用 `docker compose exec pixhelf /pixhelf --help` 查看。

也可以下载 Release 中对应架构的单文件直接运行，无需安装 FFmpeg 等组件；搜索模型会在首次启动时下载：

```bash
chmod +x pixhelf-amd64-linux
./pixhelf-amd64-linux --gallery-dir /path/to/photos
```

测试版在 **Actions → Build pixhelf-local → Run workflow** 手动构建 amd64 musl Docker 镜像，只发布 `<Forgejo域名>/<所有者>/pixhelf-local:latest`，无需另建分支。配置有 `write:package` 权限的 `REGISTRY_TOKEN` 即可，`REGISTRY_USERNAME` 默认使用触发者。正式版仍由 `v*` 标签触发，发布 amd64 / arm64 镜像到 Forgejo、Docker Hub，并提供 Release 附件。

模块分工、前后端独立开发和验证命令见[开发指南](./docs/DEVELOPMENT.md)。源码构建依赖和步骤见[构建流程](./.forgejo/actions/build-release/action.yml)，媒体组件与许可证见[第三方说明](./packaging/THIRD_PARTY.md)。

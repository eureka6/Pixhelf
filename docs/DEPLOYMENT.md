# 部署与维护

推荐安装方式见 [Docker Compose 教程](../README.md#部署)。本文补充配置和维护操作。

## 常用配置

将需要的变量添加到 `compose.yml` 的 `services.pixhelf.environment`，然后运行 `docker compose up -d` 应用配置。例如：

```yaml
services:
  pixhelf:
    environment:
      PIXHELF_WORKERS: "4"
      PIXHELF_SCAN_INTERVAL: "10"
```

这是配置片段，需与原有的镜像、端口和卷配置合并。

| 变量 | 作用 |
| --- | --- |
| `PIXHELF_TEXT_SEARCH_MODEL` | 设为 `false` 关闭自然语言搜索；Docker 默认使用镜像内的模型 |
| `PIXHELF_WORKERS` | 后台并发数，1–16；默认根据 CPU 数量选择 |
| `PIXHELF_SCAN_INTERVAL` | 扫描间隔，2–3600 秒；默认 10 秒 |
| `PIXHELF_PUBLIC_URL` | 对外访问的 HTTP / HTTPS 源地址，如 `https://photos.example.com` |
| `PIXHELF_TRUSTED_PROXIES` | 可信反向代理的 IP 网段，多个 CIDR 用逗号分隔 |

修改访问端口时调整 Compose 的端口映射，例如 `8080:3002`。完整参数以当前程序帮助为准：

```bash
docker compose exec pixhelf /pixhelf --help
```

## 数据与旧卷迁移

媒体目录保存原文件；`pixhelf-data` 卷保存账号、设置、索引和缓存。备份时同时保留媒体目录、数据卷和 `compose.yml`；复制数据卷前先停止服务，完成后再启动。

旧部署使用 `pixhelf-cache` 卷时，将 Compose 底部的卷定义替换为以下内容，服务中的挂载路径仍使用 `/data/.pixhelf-data`：

```yaml
volumes:
  pixhelf-data:
    external: true
    name: 原项目名_pixhelf-cache
```

实际卷名可通过 `docker volume ls` 查看。`docker compose down` 保留卷，附加 `-v` 会删除当前 Compose 管理的命名卷；日常更新使用 `pull` 和 `up -d`。

## 单文件部署

从仓库 Releases 下载对应架构的 Linux 文件，放到固定工作目录运行。以 amd64 为例：

```bash
chmod +x pixhelf-amd64-linux
./pixhelf-amd64-linux --gallery-dir /path/to/photos
```

arm64 使用 `pixhelf-arm64-linux`。程序内嵌媒体组件，无需另装 FFmpeg；启用中文搜索时，模型在首次启动时下载。默认数据保存在工作目录的 `.pixhelf-data/`，更换启动目录前应迁移并保留它。

## 访问与排查

首次访问创建管理员账号。公开展示请在设置中开启“免登录浏览”，上传和管理操作仍由管理员完成。公网访问使用 HTTPS 反向代理；媒体分段请求和缓存头的处理见[加载性能](PERFORMANCE.md#反向代理)。

容器状态与日志：

```bash
docker compose ps
docker compose logs --tail=100 pixhelf
```

首次扫描和搜索索引需要时间，可在页面查看后台进度。CPU、内存和流量记录的含义见[系统监控](MONITORING.md)。

# 构建与发布

本地开发见[开发指南](DEVELOPMENT.md)。正式版和测试镜像共用[构建流程](../.forgejo/actions/build-release/action.yml)，Rust 与 Node.js 版本分别由 `rust-toolchain.toml`、`.node-version` 固定。

## 发布入口

| 入口 | 产物 |
| --- | --- |
| 推送 `v*` 标签 | Linux amd64 / arm64 单文件、Forgejo 与 Docker Hub 多架构镜像、Release 附件 |
| Pull request | 构建与验证 |
| Actions → Build pixhelf-local → Run workflow | amd64 musl 测试镜像，仅发布到 Forgejo 的 `pixhelf-local:latest` |

测试镜像完整地址为 `<Forgejo域名>/<所有者>/pixhelf-local:latest`，无需另建分支。仓库配置具有 `write:package` 权限的 `REGISTRY_TOKEN`；`REGISTRY_USERNAME` 未设置时使用触发者。正式版另需 `DOCKERHUB_TOKEN` 和 `DOCKERHUB_USERNAME`。

工作流准备依赖、编译媒体组件、构建与压缩前端、运行 Rust 测试，再生成静态 musl 二进制。正式发布额外执行 UPX 压缩和独立运行检查；原生媒体源码与重建脚本随 `pixhelf-media-sources.tar.xz` 提供，详见[组件说明](../packaging/THIRD_PARTY.md)。

## 缓存与并发

缓存步骤使用 `actions/cache@v4`，避免旧版保存缓存后的退出等待。

CI 缓存 Rust / Zig 工具链、npm 下载、前端 Wasm 与 Brotli 产物、媒体运行时及 Cargo 编译结果。缓存键包含工具版本、构建脚本和锁文件；修改这些输入后会自动重新构建。前端资源缓存在 `npm ci` 后恢复，测试编译关闭调试符号和增量编译。

Runner 的缓存服务配置见 [Forgejo 文档](https://forgejo.org/docs/latest/user/actions/advanced-features/#cache)。工作流会安装 zstd；缓存不可用时正常构建。媒体编译默认使用可用 CPU，最多 8 个并发，可通过 `PIXHELF_MEDIA_JOBS` 覆盖；amd64 / arm64 缓存分别保存。

镜像仓库的 `model-<模型完整修订号>-v1` 标签复用经 SHA-256 和长度校验的模型层；后续发布只追加应用层。`build-cache` 是多架构索引的内部暂存标签。两者均用于构建；清理后会重新生成。各目标仓库验证通过后才更新版本标签与 `latest`。

## 日志与验证

`[timing]` 日志记录依赖、前端、媒体、Rust、压缩和镜像发布各阶段耗时。Cargo HTML 报告位于 `local-build-timings` / `release-build-timings` 附件。

验证镜像发布逻辑需要 `crane` 0.21.7、Node.js 和 GNU tar：

```bash
node packaging/check-publish.mjs /path/to/crane
```

检查使用两个本机临时仓库和微型模型，覆盖单 / 双架构、缓存命中、跨仓库摘要、失败时保留原标签及下载校验。

# 构建加速与计时

正式发布和 `pixhelf-local` 共用 `.forgejo/actions/build-release/action.yml`。Rust 版本由 `rust-toolchain.toml` 固定；升级时修改该文件，工具链和编译缓存会随之失效。

## CI 缓存

工作流分别缓存 Rust / Zig 工具链、npm 下载、前端 Wasm 与 Brotli 产物、媒体运行时，以及 Cargo 依赖和编译结果。缓存键包含相应的工具版本、构建脚本或依赖锁文件。前端资源缓存在 `npm ci` 之后恢复，避免被安装步骤删除。测试编译关闭调试符号和增量编译，减少缓存体积。

Runner 必须提供可访问的缓存服务，配置见 [Forgejo 缓存说明](https://forgejo.org/docs/latest/user/actions/advanced-features/#cache)。工作流在恢复前安装 zstd；缓存服务不可用或缓存未命中时，继续正常构建。首次运行仍需生成缓存。

媒体组件编译默认使用可用 CPU 数量，最多 8 个并发；通过 `PIXHELF_MEDIA_JOBS` 显式设置时使用指定值。amd64 和 arm64 的媒体产物分开保存，同一任务中的测试和发布构建复用这些产物。

## 模型层复用

镜像仓库中的 `model-<模型完整修订号>-v1` 标签保存只有模型的一层基础镜像。首次发布校验模型文件的 SHA-256 和长度后创建缓存；后续发布读取缓存镜像的摘要，检查模型身份和层数，再直接在同一仓库中追加应用层。

`build-cache` 是多架构镜像索引的内部暂存标签。后续操作使用不可变摘要，各目标仓库验证通过后才更新版本标签和 `latest`。这些缓存标签用于构建，不用于部署；清理后下一次会重新生成。

已有模型层时，不再下载 Hugging Face 模型，也不再导出包含模型的本地 OCI 目录。同步到 Docker Hub 时，只传输目标仓库中缺少的层。

## 查看耗时与验证

日志中的 `[timing]` 分别记录依赖安装、前端构建和压缩、媒体编译和压缩、Rust 测试与发布编译、UPX、独立运行检查、模型准备及镜像同步耗时。Cargo 的 HTML 报告通过 `local-build-timings` / `release-build-timings` 附件下载。

验证镜像发布逻辑需要 `crane` 0.21.7、Node.js 和 GNU tar：

```sh
node packaging/check-publish.mjs /path/to/crane
```

检查使用两个本机临时仓库和微型模型夹具，覆盖单 / 双架构发布、缓存命中时零模型下载、跨仓库摘要一致、同步失败时保留原标签，以及缓存身份和下载校验失败。不会连接生产镜像仓库。

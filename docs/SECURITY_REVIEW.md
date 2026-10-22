# 安全检查记录（2026-10-22）

本次检查当前工作区的 Rust / npm 锁文件、CI 中固定的 Python 工具、媒体组件版本，以及鉴权、上传和文件访问路径。依赖公告使用 OSV（包含 RustSec / GitHub Advisory）和 npm 官方审计服务；检查结果与当日公告数据库有关。

## 已完成的升级

| 依赖 | 原锁定版本 | 更新后锁定版本 | 原因与影响 |
| --- | --- | --- | --- |
| `rustls` | 0.23.43 | 0.23.46 | 修复 TLS 握手边界检查及会话相关问题；项目通过 reqwest 访问外部存储和下载模型。部分公告依赖未启用的 Brotli 功能或自定义会话实现，不能据此认为所有问题都可在本项目触发。 |
| `rustls-webpki` | 0.103.15 | 0.103.16 | 拒绝包含已撤销信任的 emSign 中间证书公钥的证书链。 |
| `webpki-roots` | 1.0.9 | 1.0.10 | 移除可连接到上述中间证书的根证书。 |
| `quinn-proto` | 0.11.17 | 0.11.18 | 修复可导致 panic 的 STREAM / ACK / datagram 处理；当前默认 Linux 构建未启用此可选依赖，但锁文件也同步更新。 |
| 直接依赖 `zip` | 7.2.0 | 9.0.5 | 修复解压时的符号链接越界和 Unix 权限问题。管理下载仅使用 `ZipWriter`，现有功能不接收 ZIP 解压上传。Candle 仍引入旧版，见下节。 |
| `vite` | 7.3.6 | 7.3.7 | 修复开发服务的文件访问边界、跨来源脚本和编辑器启动问题；发布后的 Rust 服务不运行 Vite。 |
| `source-map-js` | 1.2.1 | 1.2.2 | 修复恶意 indexed source map 导致事件循环拒绝服务的问题。 |

前端依赖声明同步提高至 Vite `^7.3.7`；直接 ZIP 依赖提高至 `9.0.0`，由锁文件固定为 `9.0.5`。其余依赖通过定向更新锁文件修复。

主要公告：

- [Rustls 握手检查（RUSTSEC-2026-0285）](https://rustsec.org/advisories/RUSTSEC-2026-0285.html)，以及 [0346](https://rustsec.org/advisories/RUSTSEC-2026-0346.html)、[0348](https://rustsec.org/advisories/RUSTSEC-2026-0348.html)、[0349](https://rustsec.org/advisories/RUSTSEC-2026-0349.html)。
- [根证书（RUSTSEC-2026-0381）](https://rustsec.org/advisories/RUSTSEC-2026-0381.html)和[证书校验（RUSTSEC-2026-0382）](https://rustsec.org/advisories/RUSTSEC-2026-0382.html)。
- Quinn：[0338](https://rustsec.org/advisories/RUSTSEC-2026-0338.html)、[0340](https://rustsec.org/advisories/RUSTSEC-2026-0340.html)、[0343](https://rustsec.org/advisories/RUSTSEC-2026-0343.html)。
- [Vite 文件访问边界](https://github.com/vitejs/vite/security/advisories/GHSA-rq7h-c2jc-7f22)和[source-map-js 拒绝服务](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)。

## 尚存的上游告警

### Candle 间接引入的 ZIP 7.2.0

`candle-core 0.9.2` 依赖 `zip ^7.2.0`，因此仍命中 [RUSTSEC-2026-0367](https://rustsec.org/advisories/RUSTSEC-2026-0367.html)、[0368](https://rustsec.org/advisories/RUSTSEC-2026-0368.html)、[0369](https://rustsec.org/advisories/RUSTSEC-2026-0369.html) 三条解压公告。不能声称 Rust 依赖审计已清零。

项目在 `src/text_search/model.rs` 中使用 `VarBuilder::from_mmaped_safetensors` 加载模型，没有调用 Candle 的 Pickle / ZIP 模型加载器；Candle 自身的 ZIP 读取也没有调用公告涉及的 `extract()`。本次代码检查未找到这些解压漏洞的可达调用路径。

截至检查日，crates.io 上最新稳定版 `candle-core 0.11.0` 仍依赖 `zip ^8.6.0`，公告给出的修复版本是 ZIP 9，因此直接升级 Candle 不能消除这些告警。后续应跟进 Candle 对 ZIP 9 的支持；如增加 ZIP 解压或更改模型格式，需重新评估。

### paste 停止维护

`paste 1.0.15` 由 Candle / GEMM 和 Tokenizers 间接引入，[RUSTSEC-2024-0436](https://rustsec.org/advisories/RUSTSEC-2024-0436.html) 是停止维护提示，没有提供修复版本，也不是已确认的可利用漏洞。需要跟随上游替换该依赖。

## 其它检查

- 检查了登录限流、CSRF / Origin 校验、管理员与访客路由、会话撤销、上传格式与解码限制、路径穿越和符号链接检查；本次未确认新增的应用代码漏洞。
- FFmpeg 8.1.3 已是 [8.1 分支的最新维护版](https://ffmpeg.org/download.html)；zlib 1.3.2 为[官方当前版本](https://zlib.net/)。dav1d 1.5.4 的[发布说明](https://raw.githubusercontent.com/videolan/dav1d/master/NEWS)列出优化和维护改动，本次未将其当作已确认的安全修复升级。
- CI 固定的 `cargo-zigbuild`、`ziglang`、`meson` 和 `ninja` 在此次 OSV 查询中未命中公告。
- 此次没有扫描线上宿主机、运行中的容器镜像或所有原生二进制的完整依赖树；原生媒体组件与工具版本采用官方发布说明核对。

## 验证结果

- `npm audit --package-lock-only`：0 个漏洞。
- 升级后的 OSV 锁文件查询：422 个包版本，剩余 4 条记录，即旧 ZIP 的 3 条公告和 `paste` 的停止维护提示。
- `npm --prefix frontend run build`：TypeScript 检查及 Vite 构建通过。
- `node frontend/scripts/pack-assets.mjs frontend/dist/assets target/frontend-packed`：资源打包通过。
- `PIXHELF_SKIP_FRONTEND_BUILD=1 cargo test --locked`：182 通过，0 失败，5 个依赖联网下载或额外媒体夹具的测试忽略。
- `cargo fmt --all -- --check`、`git diff --check`：通过。

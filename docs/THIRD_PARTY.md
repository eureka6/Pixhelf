# 外部代码与组件

以下记录 Pixhelf 直接引用的代码及主要运行组件。完整依赖版本分别由 [Cargo.lock](../Cargo.lock) 和 [frontend/package-lock.json](../frontend/package-lock.json) 固定。

## 直接引用与适配

- **Lucide 图标**：[frontend/src/icons.tsx](../frontend/src/icons.tsx) 选取图标路径，并使用本地 Preact 组件封装。[上游许可证](https://github.com/lucide-icons/lucide/blob/main/LICENSE)为 ISC；其中源自 Feather 的图标部分另保留 Cole Bemis 的 MIT 许可，具体清单以该许可证为准。
- **libmedia 播放器**：使用 `@libmedia/avplayer 1.3.1`。构建时的快速探测适配位于 [vite.config.ts](../frontend/vite.config.ts)，播放、方向与媒体读取适配位于 [mediaPlayer.ts](../frontend/src/mediaPlayer.ts) 和 [mediaSource.ts](../frontend/src/mediaSource.ts)。播放器及其随附许可会随前端资源打包。

## 主要组件

| 项目 | 用途 | 上游许可或说明 |
| --- | --- | --- |
| [Preact](https://github.com/preactjs/preact) | 前端界面 | MIT |
| [Axum](https://github.com/tokio-rs/axum) | Rust HTTP 服务 | MIT |
| [libmedia](https://github.com/zhaohappy/libmedia) | 浏览器视频与实况照片播放 | LGPL-3.0-or-later |
| [Chinese-CLIP](https://github.com/OFA-Sys/Chinese-CLIP) | 中文文字与图片特征匹配 | [项目 MIT 许可](https://github.com/OFA-Sys/Chinese-CLIP/blob/master/MIT-LICENSE.txt)；模型信息见下文 |
| [Candle](https://github.com/huggingface/candle) | 在 Rust 中运行搜索模型 | MIT OR Apache-2.0 |
| [heic-rs](https://github.com/tbraun96/heic-rs) | HEIC / HEVC 静态图像解码 | MIT OR Apache-2.0 |
| FFmpeg、x264、dav1d、zlib | 内嵌媒体处理程序 | 版本、配置和各自许可见[原生组件说明](../packaging/THIRD_PARTY.md) |
| [UPX](https://github.com/upx/upx) | 发布文件压缩 | GPL-2.0-or-later，附压缩可执行文件的特殊例外 |

搜索使用 OFA-Sys 的 `chinese-clip-vit-base-patch16` 模型与词表，固定修订为 `f4a64596bbcf9a2a94591b74b9dc39b2e4e77e3e`；来源与使用说明见[对应模型卡](https://huggingface.co/OFA-Sys/chinese-clip-vit-base-patch16/blob/f4a64596bbcf9a2a94591b74b9dc39b2e4e77e3e/README.md)，下载和校验逻辑位于 [src/text_search/download.rs](../src/text_search/download.rs)。

OpenList 通过 HTTP 接口连接到用户配置的服务，未内嵌其服务端代码。

## 发布附带的说明

`pixhelf --media-licenses` 输出内嵌原生媒体组件的许可文本；Release 中的 `pixhelf-media-sources.tar.xz` 提供固定版本源码和重建脚本。播放器的 `COPYING.LGPLv3` 随前端资源提供，其余依赖的许可文本保存在各自发布包中。

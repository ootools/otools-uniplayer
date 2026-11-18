# UniPlayer 上游迁移记录

本插件整体采用 **GPL-3.0-or-later**。上游 [xiaolai/uniplayer](https://github.com/xiaolai/uniplayer) 基于 IINA；保留 Collider LI 与上游贡献者的版权。固定源码：`d854ee0de166d1acfadcd35f33865df9e8b1d0c0`。GPL 许可证见 `LICENSE`。

| 本项目模块 | 上游依据 | 关系 |
|---|---|---|
| `src/domain/media.ts` 媒体分类 | `uniplayer/Utility.swift` `supportedFileExt` / `mediaType(forExtension:)` | adapted：首版支持子集，语言转写 |
| `src/domain/media.ts` 文件队列 | `uniplayer/AutoFileMatcher.swift` `getAllMediaFiles` / `addFilesToPlaylist` | adapted：分别自然排序视频、音频，视频优先；Foundation 比较器替换为 Intl.Collator |
| `src/domain/playback.ts` 完成与续播 | `uniplayer/MediaCatalogModels.swift` `CatalogMedia.isFinished/isResumable`；`uniplayer/PlaybackLoadPlan.swift` `MediaPlaybackResolver.plan` | ported：97% 完成阈值、普通打开/显式续播/从头播放的决策 |
| Web 快捷键和上一下一 | `uniplayer/PlayerCore.swift` `navigateInPlaylist`、`uniplayer/Preference.swift` 默认播放策略 | adapted：只保留浏览器可表达的基础操作，不执行 mpv 配置任意命令 |
| `src/host/contracts.ts` 轨道模型 | `uniplayer/MPVTrack.swift` 的语言/标题/codec 表达 | adapted：FFprobe 的新适配模型，不是 mpv 事件源移植 |
| `src/App.vue`、样式、宿主适配 | 无直接上游实现 | new：Web UI 与 OTools 实例/sidecar 集成 |
| `service/` | 无直接上游实现 | new：独立 Rust HTTP/HLS/FFmpeg 媒体服务 |

上游 SwiftUI/AppKit 的 VideoView、CAOpenGLLayer、libmpv render context **没有移入宿主**。本项目不声称继承原版原生渲染、HDR 保真、Transmission 或在线抓取。

## 分发义务

插件代码、服务代码、构建/打包脚本、确切运行时来源及相应修改应与二进制对应地提供。FFmpeg/FFprobe 的实际构建选项与第三方依赖许可需单独核验；API 头文件许可不代表播放器核心或预编译库整体许可。禁止把 nonfree 构建当作可再分发运行时。

宿主只提供通用实例和进程 API，插件以独立进程和公开 HTTP/HLS 协议通信。该工程边界**不是 GPL 自动豁免或法律保证**；实际分发形态须按完整作品和交互方式评估。

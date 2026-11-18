# OTools UniPlayer

基于 [xiaolai/uniplayer](https://github.com/xiaolai/uniplayer) 的独立 OTools 播放器二次开发。视频显示在宿主 tabs 中；每个视频拥有独立播放会话与 sidecar。上游业务逻辑迁移记录见 [UPSTREAM.md](UPSTREAM.md)。

## 运行

- 当前 macOS arm64 开发包已内置静态 FFmpeg/FFprobe；完整媒体回归也显式指定包内工具，不依赖 `/opt/homebrew/bin`。重新构建运行时需要 Apple 开发工具、make 与构建期 pkg-config。

```bash
pnpm install
pnpm test
pnpm build
node scripts/build-service.mjs
node scripts/build-media-runtime.mjs --jobs 8
node scripts/verify-media-runtime.mjs
pnpm dev
```

- 开发页面：`http://127.0.0.1:6576/`。普通浏览器使用明确标记的演示数据，**不能据此认定本地文件已经可播**。
- 真实播放需要包含 `instanceMode` 和按视图托管 sidecar 的 OTools **API 5**，不能只按宿主版本号判断；未提供能力的旧宿主会显示错误而不伪造路径。
- FFmpeg/FFprobe 默认使用包内 `resources/ffmpeg/<platform>/` 的工具。`FFMPEG_PATH`、`FFPROBE_PATH` 仅用于显式开发覆写；`pnpm prepare:media:homebrew` 是旧 Homebrew 开发准备路径，会生成非自包含资源，不应覆盖本轮静态包。
- SDK 依赖 npm 发布的 `otools-plugin-sdk`（本插件需要 **0.4.0+** 的 instances/sidecar lifetime 能力）；不引用宿主源码。

## 使用

1. 在 OTools 开发插件中绑定此仓库的 `plugin.json`，默认 tabs 打开。
2. 选择或拖入多个视频，各视频创建自己的标签页。再次打开同一路径默认激活已有实例；右上角提供强制新实例。
3. 音轨、基础 SRT/VTT、倍速和全局时间轴由播放器控制。关闭后保存进度；已完成（≥97%）视频普通重开从头开始。
4. 默认切换到其他标签页会暂停本实例，可在设置开启并行播放。
5. 系统文件关联在 **OTools 设置 → 文件关联** 中由用户选择，不在安装时静默抢占系统默认播放器。

## 进程与媒体边界

- 每个活实例一个 sidecar 根进程，服务内部先 probe 再使用一个 FFmpeg worker。宿主 owner 的 8 个根进程额度保持不变；第 9 个待启动实例提示等待，不杀其他视频。
- 服务只监听本机回环地址，以启动期随机内存 token 的 Authorization 头鉴权。媒体不经过 stdout/base64，路径和 token 不进入媒体 URL。
- 兼容的 H.264/AAC 优先转封装，其他格式按需转码。copy seek 以关键帧为精度，不承诺任意帧精确定位。
- 暂停、seek、倍速/音轨变更可能重建 pipeline 并短暂缓冲。有限前向窗口与缓存上限避免先转完整个文件；分离窗口也会保存位置后重建会话。
- 不包含在线下载、Transmission、完整媒体库或原版原生 HDR 保真。HDR 源的兼容状态会明确提示。

## 验证和打包

```bash
pnpm test
cargo test --manifest-path service/Cargo.toml
node --test tests/package.test.mjs
node scripts/verify-media-runtime.mjs
node scripts/test-native-playback.mjs --foreground
node scripts/pack-plugin.mjs --dev
node scripts/verify-plugin.mjs --dev
```

开发 `.oplg` 只用于当前平台调试。正式打包要求真实六平台 service 与媒体运行时齐全，检查可执行格式、架构、摘要、来源和许可；没有资产的平台**不会生成占位二进制**。

当前 macOS arm64 运行时已从锁定源码静态构建，依赖仅系统库，完整 FFmpeg/x264 源码归档、许可、构建记录和摘要随包提供。详情见 [MEDIA_RUNTIME.md](docs/MEDIA_RUNTIME.md)。其他五平台尚无产物；AV1 软件解码未包含，最低 macOS 12 部署目标尚未实机验证。

已上架 OTools 插件市场（v0.1.0，单合包，Release 标签 `plugin-otools-uniplayer-v0.1.0`）；`release` environment、`XYCLOUD_PAT` 与 `OTOOLS_PUBLISH_MARKET=true` 三件套已配置。

## 许可

整个独立插件采用 **GPL-3.0-or-later**，见 [LICENSE](LICENSE)。保留 UniPlayer / IINA 原版权，移植、新写和适配模块分别记录。

GPL 播放器、编解码器由独立 sidecar 运行，宿主只提供通用实例与进程管理接口。这个工程边界减少耦合，**不构成“独立进程自动豁免 GPL”的法律保证**。实际分发形态需据作品组合与通信方式评估，二进制应配对应源码和构建说明。

本轮工作不包含远端建仓、推送、发版、市场上架或超仓子模块指针更新。

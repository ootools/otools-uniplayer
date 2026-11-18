# macOS arm64 媒体运行时

本轮（2026-11-18）只构建和验证 **macOS arm64** 的 FFmpeg / ffprobe。两工具从锁定源码构建，FFmpeg 内部库和 x264 静态链接；运行时不需要 Homebrew、pkg-config 或另外安装的 dylib。`resources/ffmpeg/macos/runtime.json` 的 `selfContained: true` / `redistributable: true` 仅描述这个已验运行时，不代表六平台正式包已齐，也不是法律认证。

## 锁定源码与许可

`runtime-source-lock.json` 是源码版本、归档下载地址与 SHA256 的唯一锁。下载与解压各用新的独立空目录，构建脚本在仓库 `scripts/`，源码不作为脚本导入路径。构建只运行锁定源码的 configure / make，不另跑未知 hook。

| 项目 | 固定版本 / commit | 实际下载归档 SHA256 |
| --- | --- | --- |
| FFmpeg | 9.0.2 / `946fcce07b6dcd0331c8cc609192aeff5e1924f8` | `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e` |
| x264 | stable r3222 / `b35605ace3ddf7c1a5d67a2eb553f034aef41d55` | `6eeb82934e69fd51e043bd8c5b0d152839638d1ce7aa4eea65a3fedcf83ff224` |

下载地址（此次均成功使用官方地址，未使用镜像或 GitHub fallback）：

- `https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz`
- `https://code.videolan.org/videolan/x264/-/archive/b35605ace3ddf7c1a5d67a2eb553f034aef41d55/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.bz2`

FFmpeg 以 `--enable-gpl --enable-version3 --enable-libx264` 构建，分发许可为 **GPL-3.0-or-later**；x264 原源码许可为 **GPL-2.0-or-later**。未启用 `nonfree`，没有外部 codec dylib。运行时附带精确使用的完整 FFmpeg / x264 源归档、原始许可文件、源码锁、构建/校验脚本快照，以及两项目的 config.h / config.mak 作为配置证据。源码未打补丁；归档版 x264 的版本输出可能没有 git revision，准确身份以锁中的 commit 和 archive SHA 为准。

包内资源布局：

```text
resources/ffmpeg/macos/
  ffmpeg
  ffprobe
  runtime.json
  licenses/
    LICENSE.md
    COPYING.GPLv3
    COPYING.GPLv2
    COPYING.LGPLv3
    COPYING.LGPLv2.1
    x264/COPYING
  sources/
    ffmpeg-9.0.2.tar.xz
    x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.bz2
    runtime-source-lock.json
    build-media-runtime.mjs
    verify-media-runtime.mjs
    ffmpeg-config.h
    ffmpeg-config.mak
    x264-config.h
    x264-config.mak
```

`runtime.json.sha256` 覆盖除了 `runtime.json` 本身以外的每个资源文件；二进制摘要在 ad-hoc codesign 后计算。`source.ffmpeg/x264` 保留实际 URL、版本、commit、许可、configure 参数数组和相对归档路径；`sourceArchives` 是 `{name,path,sha256}` 数组。外层插件包还应摘要覆盖 `runtime.json`。正式分发时仍须提供插件/服务自身的对应源码和构建说明，不能只提供这里的 FFmpeg 源码。

## 构建

要求原生 macOS arm64、Apple clang / SDK（Xcode 或满足该编译所需的开发工具）、Node 22、make 和 **构建期** pkg-config。本次工具链为 Apple clang 21.0.0、macOS SDK 27.2；二进制和重建 x264 的部署目标均为 **macOS 12.0**。这里只在当前机器运行验证，没有在 macOS 12 实机上测试。

在插件仓库运行：

```sh
node scripts/build-media-runtime.mjs --root "$PWD" --jobs 8
```

可显式指定已经下载的归档；仍会强制核对锁中 SHA256：

```sh
node scripts/build-media-runtime.mjs --root "$PWD" \
  --ffmpeg-source /absolute/download-dir/ffmpeg-9.0.2.tar.xz \
  --x264-source /absolute/download-dir/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.bz2 \
  --jobs 8
```

其他选项：`--cache /absolute/cache-dir` 指定源码/构建缓存，`--sources-only` 仅下载并核验归档；`--jobs` 取 1–8，默认 8。默认缓存 `.media-runtime-cache/` 已 gitignore，旧运行时备份 `.tempbackups/` 同样已忽略。不要把缓存源码当工作目录运行额外解释器/脚本；脚本使用明确的源/输出路径，仅在独立构建目录调用已锁定 configure 和 make。

构建要点：

- x264：static、PIC、8/10-bit（`--bit-depth=all`），禁 CLI、OpenCL 和可选外部 CLI 输入库；不复用本机 Homebrew `libx264.a`（其 object minos 为 27）。
- FFmpeg：`--target-os=darwin --arch=aarch64 --enable-static --disable-shared --disable-autodetect --enable-gpl --enable-version3 --enable-libx264 --disable-network --disable-opencl --disable-ffplay --disable-doc --enable-ffmpeg --enable-ffprobe`，显式启用系统 VideoToolbox / AudioToolbox。
- C/C++/汇编/链接使用 Apple SDK、`-arch arm64 -mmacosx-version-min=12.0`；构建 PATH 仅系统目录。pkg-config 可来自 Homebrew，但其 `PKG_CONFIG_LIBDIR` 是仅含本次重建 `libx264.a` 的私有前缀，`PKG_CONFIG_PATH` 清空且采用 `--static`。构建工具来源不等于运行时链接依赖。
- 保留默认 FFmpeg 内置 codec、demuxer、muxer 和 filter，不采用易漏功能的 `--disable-everything`；保留 avdevice 的 lavfi 以便合成真实测试媒体。
- 先在 sibling candidate 目录签名并验证两工具、实际 otool、对应源码/许可摘要和搬迁后的真实媒体操作；只有全部通过后才置两个 true 标记、备份旧运行时并替换。下载/编译/候选验证失败不会覆盖旧 `macos/`。验证失败可对已编译输出重试 finalization，无需误重用未校验元数据。

本次最初编译已成功，候选验证曾因 verifier 将 linker 的 `version 27106.1` 当成 minos、以及 FFmpeg 9 的 device/filter 列解析差异而拒绝；这些问题各经失败回归测试修正，复用同一编译产物重新做完整验证后才替换，未绕过验证。完整编译日志保留在 `.media-runtime-cache/ffmpeg-build.fgq43Q/make-output.log` 和 `.media-runtime-cache/x264-build.FN8UNN/make-output.log`。旧 Homebrew 开发运行时保存在 `.tempbackups/media-runtime-macos.JHokz5/macos/`。

## 能力与明确限制

实际能力清单检查覆盖：H264 / HEVC / VP8 / VP9 decoder；AAC / FLAC / MP3 / PCM / Vorbis / Opus decoder；mov、matroska/webm、avi、mpeg、mpegts、mp3、aac、flac、wav、ogg demuxer；libx264 / AAC encoder；fMP4 HLS、WebVTT、null muxer；scale / format / tonemap filter；`file` 和 `pipe` 协议（字幕输出用 pipe）。网络协议关闭。

**AV1 软件解码不包含在这个两源码运行时。** FFmpeg 内置 `av1` 是硬件解码入口；未附 libdav1d / libaom，service 当前命令没有显式选择 AV1 hardware acceleration，因此不能把 decoder 清单中有 `av1` 当成真实 AV1 播放支持，也未承诺本机 AV1 硬解可用。后续若需软件 AV1，须新增可追溯静态库源码/许可/锁与真实解码测试。HEVC / VP8 / VP9 和部分音频格式本轮检查编译清单，但不等于逐格式/逐 profile 的真实播放测试。

HDR 使用 FFmpeg 9 内置 scale＋tonemap 转 8-bit SDR，未附 libzimg；不承诺原生 HDR 保真。当前 service 的 High10/HDR、字幕与 FLAC 实测另见 service 测试结果。

## 校验与测试

```sh
node scripts/verify-media-runtime.mjs --root "$PWD"
node --test tests/package.test.mjs tests/media-runtime.test.mjs
FFMPEG_PATH="$PWD/resources/ffmpeg/macos/ffmpeg" \
FFPROBE_PATH="$PWD/resources/ffmpeg/macos/ffprobe" \
  cargo test --manifest-path service/Cargo.toml
pnpm test
```

CLI 也支持 `--directory /absolute/resources/ffmpeg/macos`。完整校验实际运行 `otool -L/-l`、`codesign --verify --strict`，不只信任 selfContained 标记；只允许 `/System/Library/` 和 `/usr/lib/` 的 dylib，拒绝 Homebrew、`@rpath`、`@loader_path` 和过高 minos。确认实际 executable config 与 metadata 一致，并逐文件核摘要/源码锁/许可。

本轮 runtime 测试 **11/11 通过**，先对旧非自包含运行时看见失败，再验证新运行时：

- 错误 source SHA 在解压/替换前拒绝；危险 tar 路径/链接拒绝；真实搬迁的 Homebrew ffmpeg 拒绝。
- minos 检查与 linker/source version 分离，FFmpeg 9 新 device/filter 列解析回归。
- 工具搬到新的临时目录，环境 `PATH=/usr/bin:/bin`、没有 `FFMPEG_PATH` / `FFPROBE_PATH` 或 DYLD 注入变量，`-version` / `-h` 成功。
- 实际 H264/AAC encode / probe / decode、FLAC→PCM、fMP4 HLS copy 分段及合并后解码、2.5s 精确 seek 转码并解码。
- 真实 `player-macos --stdio` 与 bundled tools 一起搬迁，服务按自身 exe 相对路径找工具，无路径 overrides；验证 copy HLS、关键帧 seek、旧 generation HTTP 410、FLAC-MKV 精确 transcode、嵌入 subrip→WEBVTT、stdin EOF 正常退出。
- 篡改对应源码或删除 x264 COPYING 后 verifier CLI 拒绝。

前端 `npm test` **41/41 通过**。完整 `cargo test --manifest-path service/Cargo.toml` 指定新 FFmpeg / ffprobe 后 **26/26 通过**（2 pipeline、6 core、11 HTTP、3 security、4 stdio），含 High10/HDR→8-bit SDR、FLAC 音轨、字幕、64 秒有限预读窗口、pause/seek 和 worker 清理。其他宿主/native/六平台关卡不由这里替代。

本次最终签名后二进制 SHA256：

```text
ea3c5973a6e8584dce04c97f3403890877cac0acf5953082b0baa7f80516645f  ffmpeg
904c471285c9102b493eaaedaa0d0770aaebe9f741c0625a5c09a23426a48f47  ffprobe
```

资源目录约 57 MiB，其中两可执行各约 22 MiB，完整对应源码归档随包携带；未制作其他五平台占位二进制，未提交/推送或远端发布。

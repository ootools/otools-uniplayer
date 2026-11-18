# 验证记录 — 2026-11-18

## 实现范围

- 平级独立 GPL-3.0-or-later 播放器：Web UI＋Rust/FFmpeg sidecar，不将播放器库链接进宿主。业务移植与 `xiaolai/uniplayer` 固定 SHA、逐项 port/adapt/new 记录见 `UPSTREAM.md`。
- 宿主 API5 增加 opt-in 文档多实例、默认 tabs、source+UUID 权限、canonical path 复用/force-new、严格目标文件投递、activity/current、view-generation sidecar 清理及 tray/detach 恢复。
- 实际 HLS/fMP4：H.264/AAC copy，其它测试组合转码；seek generation、关键帧精度、音轨、SRT/VTT、有限 64 秒生产窗口、消费 GC、缓存上限和 FFmpeg 子进程回收。
- 自包含 macOS arm64 FFmpeg9.0.2+x264 r3222；最低 minOS12；完整锁定源归档、构建配置、许可证及签名后的哈希随资源分发。

## 最新自动验证

| 检查 | 最新结果 |
|---|---|
| Plugin Vitest | 41/41；`pnpm build`（Vue/TS + Vite）通过 |
| Plugin package/runtime tests | 11/11 通过 |
| 静态 runtime verifier | 通过；签名、minOS12、所有 dylib 仅系统、源/配置/许可证逐文件 SHA256 |
| Media service Cargo | 27/27：2 pipeline race + 7 core + 11 HTTP + 3 security + 4 stdio/lifecycle |
| Host 完整 Rust lib | 527 passed、7 ignored、0 failed |
| Host 定向实例/API5 测试 | 最新重跑 56/56；Host `vue-tsc --noEmit --pretty false` 通过 |
| 隔离 profile config/default presentation | 9/9 + 9/9；隔离 feature build 通过；release 条件编译拒绝测试 feature |
| Host/SDK 集成回归 | 已验证 Host 75/75、SDK 34/34 + build/injection；变更后最终定向 Host 56/56 |
| pack/verify | macOS 开发 `.oplg` 28 files 通过；正式包因其余平台缺少真实资产而拒绝 |

大范围相关 Host UI suite 保留两项已确认是 HEAD 遗留的菜单数组失败（`Tools.windowActions.test.ts` 两项）。HEAD 的菜单已有 fullscreen-screenshot，HEAD 旧预期数组遗漏；两个源文件本轮均未修改。没有删项或改断言来声称全套绿。证据及 625/627 结果见前次 suite 日志 `/tmp/otools-uniplayer-host-vitest-final.log`。

## 隔离真实宿主验收

通过仅 debug 编译的 `host-integration-test`：使用唯一 bundle identifier、canonical 0700 临时 `OTOOLS_HOME`、incognito WebViews 和本机合成文件。不触碰已安装 OTools / 用户 HOME / OS 默认文件关联；运行前后 fixed live single-instance socket 未变。Release 误启该 feature 会被 compile error 拒绝。

真实 Tools + WebViews + 宿主 API/sidecar 流程通过：

- 两个 argv 文件开为两个 source-aware 实例 tab；相同路径再次投递复用，`reuse:new` 创建新身份。
- current/activity、默认 inactive lazy start/暂停、切换恢复、parallel setting、copy 与 transcode 实际帧、全局 seek/generation、SRT subtitle 均通过。
- 关闭单 tab 后它的进程回收、兄弟视频继续；宿主正常退出时所有观察到的服务根/worker 均退出。
- 对 sibling view 使用其他实例的 sidecar handle 被拒。
- Source 开发入口 run 2 报告 `/tmp/otools-real-host-run2.log`；生产 bundle 分支 `/tmp/otools-real-host-package2.log`。结构化隔离证据（含临时 profile 路径）见 `verification-host.json`。

生产包分支在隔离 profile 安装 exact binary hash/size/path 登记，以 `market` owner 通过 `otools-plugin://localhost/otools-uniplayer/dist/index.html` 来源加载；视频实际 decode/advance，缺 Bearer 返回401，正常关闭服务 root/workers 无残留。observer 只注入在临时 copy 的 index，未改 production `dist` 与 SDK/API。首轮 package negative-control 因 WK CORS 不暴露未授权响应而失败；改用 Node direct HTTP 配精确 custom Origin 后第二轮通过，保留原始日志。

## 原生媒体验收与保留失败

- 自包含静态工具在独立、nonPersistent、visible 非激活 WKWebView：实际 H.264/AAC copy + H.264/FLAC transcode 双视频、帧推进、seek、暂停一个而另一个继续、custom Origin/Bearer、关闭回收通过；无 Homebrew overrides。
- 静态 runtime 在隔离目录搬移，PATH 仅 `/usr/bin:/bin`，实际 version/help/encode/probe/decode/HLS/seek 均通过。
- **保留一次 hidden/occluded 独立 WKWebView 50 秒 timeout**：其 seek 后媒体页不再回报帧；服务控制接口经独立测试 ACK 正常且退出回收成功。后续 visible 非激活跑通过，真实 OTools hidden tab 在一次宿主 run 也推进过。后台调度/遮挡是疑点，未证明根因；不声称任意隐藏状态持续播放稳定。报告 `verification-native-static.json` 与 `/tmp/otools-uniplayer-native-diagnostic.log`。

## 运行时、包与限制

- 当前 `.oplg`：`dist-pack/otools-uniplayer-0.1.0-dev-macos.oplg`，28 files，pack/verify 通过；不是 6 平台正式包。
- FFmpeg9.0.2 + 静态 x264 的运行时自包含：`otool -L` 只列系统框架和 `/usr/lib`；部署目标为 macOS12。**未在 macOS12 实机跑**。
- 两个源码归档、两项许可证、configure/config 证据及全部 runtime 哈希见 `resources/ffmpeg/macos/runtime.json` 和 `docs/MEDIA_RUNTIME.md`。非无担保法律意见；独立进程不是自动 GPL 豁免。
- 不提供软件 AV1 解码；HDR 输入转 SDR，不承诺原生 HDR 保真；ASS 样式不保留，seek/暂停/变速等重建 pipeline 可能短暂 buffering。
- 其它 5 平台无实际 asset；Windows/Linux/Intel macOS 未实机测试。系统默认文件关联由用户在设置里选，本轮未修改 OS 关联。
- 未 commit/push、未建远端仓库、未 release/上架、未更新父仓子模块指针。

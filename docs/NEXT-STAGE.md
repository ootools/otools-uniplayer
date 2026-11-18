# 下一阶段 — 本机可搬移与真实宿主验收

日期：2026-11-18。继续已批准播放器计划，保持 main，不提交、推送或发布；不更新超仓指针。

## 已闭环结果（2026-11-18）

1. **隔离真实宿主**：通过 release 同 socket profile 隔离验证。Debug-only `host-integration-test` 使用独立 bundle id、canonical 0700 临时 `OTOOLS_HOME` 和 incognito WebViews；release 模式通过 `compile_error!` 拒绝该 feature。未触碰已安装 OTools、用户 HOME、系统关联、全局快捷键或 live socket。
2. **源码开发实例链路**：两 argv 文件创建两个实际 Tools tabs 和独立 sidecar；同文件复用、`reuse:new`、API `current/onActivity`、inactive lazy-start/暂停、copy/transcode、seek generation/global position、SRT、关闭单 tab 隔离、宿主退出回收均实际通过。
3. **生产 bundle 协议来源**：临时 profile 安装精确 sidecar 哈希登记，原样 `dist/index.html` 在 `otools-plugin://localhost` source=market 加载；Bearer 鉴权和一段视频实际呈帧/推进、正常回收通过。只在 profile 的 bundle 副本 index 注入只读 observer，不改 repo dist 或生产 API。
4. **macOS arm64 静态媒体源**：FFmpeg9.0.2 + x264 r3222 静态重建，仅系统 dylib，minimum macOS12；源码锁、来源归档、许可、configure、签名后 hashes 同包。无 Homebrew 动态依赖的搬迁/CLI/HLS/seek service smoke 与 runtime verification 通过。
5. **开发包**：使用当前 macOS 静态 runtime 的 28-file `.oplg` 已 pack/verify；正式包继续因其他五平台 binary 与运行时缺失而拒绝，不创建占位物。

## 保留限制

- 隐藏并行在一轮实际宿主 Tabs 观察到两个 video 都推进；此前 standalone occluded WK run 在 seek 后超时（服务/root清理完成，原生回调停更）。此差异仍是调度/遮挡疑点，不是已证明根因；不得声称所有隐藏场景稳定。
- production bundle 测试证明真实 packaged document、market owner、登记 executable/hash、loopback HLS/auth与退出；其 per-bundle read-only observer 为专用接受性辅助，完整交互驱动仍由源码宿主 dev fixture flow覆盖。
- 没有注册 OS 默认关联或测试 Windows/Linux/Intel Mac/Windows ARM；macOS12 实机也未有设备复核。
- 没有远端建仓、push、release、market publish 或更新 xyito 父模块指针。

原始 detailed commands、日志与保留失败见 `VERIFICATION.md`、`verification-host.json`、`verification-native.json`、`verification-native-static.json`、`MEDIA_RUNTIME.md`。

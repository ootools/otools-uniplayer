# OTools UniPlayer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement task-by-task. Approval already granted; continue without another permission round.

**Goal:** 独立GPL播放器插件、真实视频tabs、多文件实例和可靠sidecar清理。

**Architecture:** Vue3/HLS.js包内页面＋Rust axum/FFmpeg本机服务。宿主增加opt-in文档实例和view-scoped sidecar，权限仍按source+UUID。

**Tech Stack:** TypeScript/Vue/Vite/Vitest、Rust/Tokio/axum、FFmpeg/ffprobe。

**Spec:** ../specs/2026-11-17-otools-uniplayer-design.md

## Global Constraints

- main直接开发；不建worktree、不提交推送/发版/登记超仓指针。
- 独立仓自包含，SDK快照，不引用宿主源码。
- GPL插件对应源码、版权和运行时许可必须可追溯。
- 8额度计服务根进程，每服务最多1 worker，probe先完成。
- 阶段通过以实际命令为证，跨平台未实测不称通过。

## Review Focus

- 两个同UUID实例不得串文件、输出、播放状态。
- 已关闭generation不得启动/杀掉重建后的新进程。
- 慢消费或暂停不得删未消费段、无界占盘。
- 相同文件强制new与恢复/detach保留独立身份。
- 媒体URL、控制接口不得绕过认证/Origin/路径限制。

---

### Task 1: sidecar view lifetime

**Files:** host platform/sidecars/{manager,service,transport}.rs；webview/core.rs；runtime/otools/sidecar-factory.ts；SDK sidecar-types.ts；相邻tests。
**Interfaces:** spawn options lifetime?:'plugin'|'view'；attachment由宿主推导(label,generation)，默认plugin不变；view_closed使generation失效并清理。

- [ ] RED：两个view隔离输出/操作、关闭阻止late spawn、同label新代不被旧代清理。
- [ ] 看见预期失败，再实现attachment、cleanup与精确投递。
- [ ] GREEN：sidecars Rust测试、TS bridge定向测试；保留现有owner lifecycle。

### Task 2: document instances and file routing

**Files:** host Tools.vue、plugins.ts、pluginPrefs.ts、fileOpenRouting.ts、Panel.vue；config/core.rs、file_open.rs、webview/core.rs；新增聚焦instances模块；runtime factory与SDK instances类型。
**Interfaces:** instanceMode?:'single'|'multiple'；instances.open({files:string[],reuse?:'document'|'new'})→Promise<实例结果[]>；instanceId/source/document字段持久化。host request ACK only sameowner。

- [ ] RED：两文件两tab、重复激活、force new、source隔离、strict dead target、旧config保留、opt-in默认tabs。
- [ ] 复用OS intake和targetLabel，增加规范路径、预留实例、绑定后投递，实例恢复和detach。
- [ ] GREEN：相关Vitest、Rust config/file-open测试、vue-tsc。

### Task 3: media service and runtime

**Files:** plugin service/{Cargo.toml,src/{main,api,probe,pipeline,media,cache}.rs}、tests、runtime source metadata、scripts prepare/build。
**Interfaces:** ready JSON {event:'ready',port}，token通过stdin启动握手；Authorization header；POST /api/open、/api/seek、/api/pause、/api/progress，GET /media/:generation/...。响应含probe、mode、generation、effectiveStart、playlist URL。

- [ ] RED：auth/Origin/Host、路径限制、probe坏输入、seek stale、cache预算、暂停清理。
- [ ] 实现ffprobe先行、H264/AAC copy和转码、官方HLS muxer、generation和原子分段、时间/字节硬界、子进程结束清理。
- [ ] GREEN：cargo test、合成视频真实HTTP HLS/seek/并发；检查运行时buildconf/许可证，不打包nonfree。

### Task 4: standalone UI and upstream ports

**Files:** package.json/lock、vite/ts配置、plugin.json/logo、src/{App,components,player,host,domain,theme,i18n}、i18n、LICENSE/UPSTREAM。
**Interfaces:** Task2实例API；Task1view lifetime；Task3服务控制。浏览器mock只替换外部host adapter。

- [ ] RED：上游分类/自然排序/续播97%边界/轨道/快捷键、chunked stdout/parser、generation响应。
- [ ] 实现Web播放器、host file dialog/drop/onOpen、HLS授权loader、controls、file list、空/错误/额度状态、current/parallel policy、close保存和detach恢复。
- [ ] SDK构建快照与来源记录、锁定依赖、GPL溯源。
- [ ] GREEN：tests、vue-tsc/build，真实WKWebView MSE/HLS/seek关卡后继续完整体验。

### Task 5: packaging, integration and final review

**Files:** scripts/{pack-plugin,verify-plugin,serve-dist,build-service,prepare-media-runtime}.mjs、runtime metadata、README、verification记录。

- [ ] RED：本机包结构/摘要、declared exe与资源/许可缺失拒绝、正式六平台不齐拒绝。
- [ ] 实现dev当前平台包与正式六平台合包，exe定位resources、签名后哈希，锁定FFmpeg来源。无占位binary。
- [ ] GREEN：脚本集成、package验证、双视频真实GUI+host隔离测试。
- [ ] Fresh whole-change review；重要发现RED→GREEN；最终报告产物、验证平台和剩余限制。

## Progress

见同目录 ../../progress.md，记录每任务证据、裁定与未完成项。无需生成技能默认commit记录，因为用户批准本轮不提交。

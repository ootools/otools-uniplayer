# OTools UniPlayer 设计（已批准）

日期：2026-11-17。目标：与宿主平级、GPL-3.0-or-later 独立播放器插件，视频画面位于 OTools tabs，文件关联、多视频实例和续播。

## 架构与边界

采用 Web UI＋独立 GPL sidecar 媒体服务（方案 B）。方案 A 保留原生播放器但画面在独立窗口；方案 C 需要新增跨进程原生表面嵌入，首版不采用。上游 xiaolai/uniplayer 固定 d854ee0de166d1acfadcd35f33865df9e8b1d0c0，为 macOS SwiftUI/AppKit/libmpv 应用，没有可直接嵌入的 Web 前端。

移植分类表、队列策略、续播决策（97% 完成）、轨道/播放状态与基础快捷键语义；逐模块记 ported/adapted/new 和版权。Web UI、HTTP/HLS、FFmpeg 适配是新实现。整个插件 GPL-3.0-or-later，宿主只提供通用实例/sidecar 功能。独立进程和公开协议减少耦合，不承诺自动免除宿主 GPL 义务。所有发行物需提供对应源码、构建说明和第三方许可。

## 第一版

Vue3/TS/Vite；本地主题/强调色，中英文本，mock 预览。文件选择、拖放、系统打开统一为实例请求；不同文件各开 tab，同一路径默认复用，可强制新实例。文件列表、视频、全局进度、暂停/音量/倍速/上一下一/音轨/基础字幕/全屏。当前实例默认播放，其他暂停，可选择并行。续播按上游规则；分离窗口保存位置、重建服务并允许短暂缓冲。不含在线抓取、Transmission、完整媒体库和原生 HDR 保真。

## 服务契约

Rust/Tokio/axum，每个活跃 tab 一个服务根进程，probe 和 FFmpeg worker 不重叠。宿主每 owner 最多8个服务；第9个明确等待，不杀其他播放实例、不循环重试。监听 127.0.0.1:0，stdout 小条 JSON ready；Authorization Bearer 随机内存 token，校验 Host/Origin/CORS。路径和 token 不进 URL/日志。页面保持包内 origin，用 HLS.js 给全部媒体请求加认证头；不承诺未经验证的 native HLS fallback。

兼容 H264/AAC 优先 fMP4 HLS 转封装，其他编码转 H264/AAC；报告模式与 HDR/SDR 状态。probe 时长为全局时间轴。seek/暂停恢复/必要倍速变更递增 generation 重建 pipeline，记录实际起点，拒绝过期结果；copy 仅关键帧精度。FFmpeg 官方 HLS muxer＋受控 readrate，服务管理有限预读、已发布段与消费位置。时间/字节双限，预算触顶停止生产，不能先删未消费段。暂停停产。SRT/VTT 基础字幕；ASS 样式损失明确显示。

先验通实际 OTools WKWebView 的 MSE、授权、seek 和慢消费；浏览器成功不替代宿主验证。失败定位报告，不虚称支持。

## 宿主扩展

清单 instanceMode:single|multiple，默认single，播放器multiple+tabs。权限owner仍source+UUID；instanceId用作tab/label/config身份。canonical path用于文档去重，source隔离。SDK instances.open({files,reuse:'document'|'new'})只操作本owner，request/ACK，创建绑定后定向投递。multiple不按UUID首tab或Panel复用，strict-target目标死后不交给兄弟view。Panel仅对opt-in multiple采用清单tabs默认，旧插件和显式目的地保持。持久化source/instance/document/title，恢复懒启动。

sidecar.spawn(...,{lifetime:'view'})保持默认plugin兼容。宿主推导label+generation attachment，关闭/销毁收割进程树、定向输出，防spawn/close和旧generation竞态。before-close ACK用于保存，不能单靠它清理。detach销毁重建，不能复用handle。复用Unix进程组/Windows Job和已有停用/升级/退出清理。

## 分发与验证

SDK快照package+dist+LICENSE+来源SHA，不引宿主源码。bin仅声明exe；FFmpeg/ffprobe与许可置resources按exe定位。六平台供应需来源/版本/config/SHA/对应源码及依赖许可锁，排除nonfree；先本机包后六平台正式合包，无占位二进制。系统默认关联只由用户设置，不静默修改。

回归覆盖旧single、多文件定向、重复/new、source、目标关闭、恢复/detach、spawn-close/generation/进程子树/8额度；服务auth/CORS/坏文件/seek/缓存/暂停倍速/字幕；类型检查、相关Rust/前端测试、浏览器GUI和真实WKWebView。未验证平台如实记录。

## 工作约束

main直接开发，不创建worktree；不commit/push/远端建仓/发版/超仓指针更新。保留并发修改。实现细节可作最小合理裁定并记录进度。

// Standalone native integration runner. It does not attach to or activate OTools.
// Compile: xcrun swiftc tests/native-webview.swift -o /tmp/native-webview
// Input: one JSON line on stdin (or UNIPLAYER_NATIVE_TEST_CONFIG); never a token URL.
import AppKit
import WebKit
import Foundation

@MainActor
final class NativePlaybackRunner: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    private let input: [String: Any]
    private let pageURL: URL
    private let secrets: [String]
    private var window: NSWindow?
    private var webView: WKWebView?
    private var deadline: Timer?
    private var heartbeat: Timer?
    private var startedUptime = ProcessInfo.processInfo.systemUptime
    private var lastPageUptime: TimeInterval?
    private var lastPageEvent = "none"
    private var lastPageStage = "navigation"
    private var finished = false

    init(input: [String: Any], pageURL: URL) {
        self.input = input
        self.pageURL = pageURL
        self.secrets = (input["services"] as? [[String: Any]] ?? []).flatMap { service in
            [service["token"] as? String, service["path"] as? String].compactMap { $0 }.filter { !$0.isEmpty }
        }
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        startedUptime = ProcessInfo.processInfo.systemUptime
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.allowsAirPlayForMediaPlayback = false
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.add(self, name: "test")
        do {
            let data = try JSONSerialization.data(withJSONObject: input, options: [.sortedKeys])
            guard let json = String(data: data, encoding: .utf8) else { throw RunnerFailure.invalidInput }
            let source = "Object.defineProperty(globalThis, '__UNIPLAYER_NATIVE_TEST__', { value: \(json), writable: false, configurable: false });"
            configuration.userContentController.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        } catch {
            finish(["event": "result", "status": "failed", "stage": "configuration", "message": "Unable to inject the native test configuration."])
            return
        }

        let frame = NSRect(x: 80, y: 80, width: 800, height: 540)
        let view = WKWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: configuration)
        view.navigationDelegate = self
        view.autoresizingMask = [.width, .height]
        let testWindow = NSWindow(contentRect: frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        testWindow.title = "UniPlayer isolated native integration test"
        testWindow.isReleasedWhenClosed = false
        testWindow.hidesOnDeactivate = false
        testWindow.isExcludedFromWindowsMenu = true
        testWindow.contentView = view
        window = testWindow
        webView = view
        // Remain non-key and non-activating. Occlusion is observed, not bypassed;
        // WebKit may suspend page callbacks once neither video is producing audio.
        // Never call activate(), makeKeyAndOrderFront(), or manipulate another application.
        if input["visibility"] as? String == "foreground" {
            testWindow.orderFrontRegardless()
        } else {
            testWindow.orderBack(nil)
        }
        heartbeat = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.emitNativeHeartbeat() }
        }
        deadline = Timer.scheduledTimer(withTimeInterval: 50, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.emitNativeHeartbeat()
                self.finish(["event": "result", "status": "failed", "stage": "timeout", "lastPageStage": self.lastPageStage,
                             "lastPageEvent": self.lastPageEvent, "message": "Native WKWebView test exceeded 50 seconds."])
            }
        }
        emit(["event": "runner", "status": "started", "platform": ProcessInfo.processInfo.operatingSystemVersionString, "dataStore": "nonPersistent", "activatesApplication": false, "timeoutSeconds": 50])
        view.load(URLRequest(url: pageURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 12))
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard !finished, message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.host == pageURL.host,
              message.frameInfo.securityOrigin.protocol == pageURL.scheme,
              message.frameInfo.securityOrigin.port == pageURL.port,
              let report = message.body as? [String: Any],
              JSONSerialization.isValidJSONObject(report) else { return }
        lastPageUptime = ProcessInfo.processInfo.systemUptime
        lastPageEvent = report["event"] as? String ?? "unknown"
        if let stage = report["stage"] as? String { lastPageStage = stage }
        if report["event"] as? String == "result" {
            finish(report)
        } else {
            emit(report)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard navigationAction.targetFrame?.isMainFrame != false else { return .allow }
        guard let url = navigationAction.request.url,
              url.scheme == pageURL.scheme, url.host == pageURL.host, url.port == pageURL.port,
              url.path == pageURL.path, url.query == nil, url.fragment == nil else {
            finish(["event": "result", "status": "failed", "stage": "navigation", "message": "Refused navigation outside the isolated HTTP test page."])
            return .cancel
        }
        return .allow
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(["event": "result", "status": "failed", "stage": "navigation", "errorCode": (error as NSError).code])
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(["event": "result", "status": "failed", "stage": "navigation", "errorCode": (error as NSError).code])
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        finish(["event": "result", "status": "failed", "stage": "web-content-process", "message": "The isolated WebKit content process terminated."])
    }

    private func emitNativeHeartbeat() {
        guard !finished else { return }
        let now = ProcessInfo.processInfo.systemUptime
        emit(["event": "native-heartbeat", "lastPageEvent": lastPageEvent, "lastPageStage": lastPageStage,
              "pageSilenceSeconds": lastPageUptime.map { now - $0 } ?? -1,
              "windowVisible": window?.isVisible ?? false, "windowOcclusionVisible": window?.occlusionState.contains(.visible) ?? false,
              "windowKey": window?.isKeyWindow ?? false, "applicationActive": NSApplication.shared.isActive,
              "webViewLoading": webView?.isLoading ?? false])
    }

    private func emit(_ report: [String: Any]) {
        var timedReport = report
        timedReport["nativeElapsedSeconds"] = ((ProcessInfo.processInfo.systemUptime - startedUptime) * 1000).rounded() / 1000
        timedReport["nativeTimestampUTC"] = ISO8601DateFormatter().string(from: Date())
        guard let data = try? JSONSerialization.data(withJSONObject: timedReport, options: [.sortedKeys]),
              var line = String(data: data, encoding: .utf8) else { return }
        for secret in secrets {
            line = line.replacingOccurrences(of: secret, with: "[redacted]")
            if let quoted = try? JSONSerialization.data(withJSONObject: [secret]),
               let escaped = String(data: quoted, encoding: .utf8) {
                line = line.replacingOccurrences(of: String(escaped.dropFirst(2).dropLast(2)), with: "[redacted]")
            }
        }
        print(line)
        fflush(stdout)
    }

    private func finish(_ report: [String: Any]) {
        guard !finished else { return }
        finished = true
        deadline?.invalidate()
        heartbeat?.invalidate()
        emit(report)
        webView?.stopLoading()
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "test")
        window?.orderOut(nil)
        window?.close()
        let passed = report["status"] as? String == "passed"
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { exit(passed ? EXIT_SUCCESS : EXIT_FAILURE) }
    }
}

enum RunnerFailure: Error { case invalidInput }

@main
struct NativePlaybackMain {
    @MainActor
    static func main() {
        do {
            let raw = ProcessInfo.processInfo.environment["UNIPLAYER_NATIVE_TEST_CONFIG"] ?? readLine() ?? ""
            guard raw.utf8.count <= 64 * 1024,
                  let data = raw.data(using: .utf8),
                  let input = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let url = URL(string: input["pageURL"] as? String ?? "http://127.0.0.1:6576/tests/native-playback.html"),
                  url.scheme == "http", url.host == "127.0.0.1", url.port == 6576,
                  url.path == "/tests/native-playback.html", url.query == nil, url.fragment == nil,
                  url.user == nil, url.password == nil else { throw RunnerFailure.invalidInput }
            let app = NSApplication.shared
            app.setActivationPolicy(.accessory)
            let delegate = NativePlaybackRunner(input: input, pageURL: url)
            app.delegate = delegate
            withExtendedLifetime(delegate) { app.run() }
        } catch {
            print("{\"event\":\"result\",\"status\":\"failed\",\"stage\":\"input\",\"message\":\"Expected isolated HTTP native-test JSON on stdin.\"}")
            exit(EXIT_FAILURE)
        }
    }
}

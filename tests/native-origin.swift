import AppKit
import WebKit

@MainActor
final class OriginProbe: NSObject, WKURLSchemeHandler, WKScriptMessageHandler, WKNavigationDelegate {
    var view: WKWebView?
    func start() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(self, forURLScheme: "otools-plugin")
        config.userContentController.add(self, name: "report")
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 500, height: 300), configuration: config)
        self.view = view
        view.navigationDelegate = self
        view.load(URLRequest(url: URL(string: "otools-plugin://localhost/otools-uniplayer/dist/index.html")!))
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { print("{\"error\":\"origin probe timed out\"}"); exit(1) }
    }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let html = """
        <!doctype html><meta charset="utf-8"><script>
        webkit.messageHandlers.report.postMessage({ origin:location.origin, scheme:location.protocol, href:location.href, secure:isSecureContext });
        </script>
        """
        let bytes = Data(html.utf8)
        urlSchemeTask.didReceive(URLResponse(url: urlSchemeTask.request.url!, mimeType: "text/html", expectedContentLength: bytes.count, textEncodingName: "utf-8"))
        urlSchemeTask.didReceive(bytes)
        urlSchemeTask.didFinish()
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let data = try? JSONSerialization.data(withJSONObject: message.body, options: [.sortedKeys]), let line = String(data: data, encoding: .utf8) else { exit(1) }
        print(line)
        exit(0)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        print("{\"errorCode\":\((error as NSError).code)}")
        exit(1)
    }
}
@main
struct ProbeMain {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let probe = OriginProbe()
        probe.start()
        withExtendedLifetime(probe) { app.run() }
    }
}

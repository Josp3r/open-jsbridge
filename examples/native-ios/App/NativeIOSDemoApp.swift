import NativeIOSHost
import SwiftUI
import WebKit

@main
struct NativeIOSDemoApp: App {
    var body: some Scene {
        WindowGroup {
            #if DEBUG
            WebDemo()
            #else
            ReleaseWebDemo()
            #endif
        }
    }
}

#if DEBUG
private struct WebDemo: UIViewRepresentable {
    private let url = URL(string: "http://127.0.0.1:4173/?host=native")!

    func makeUIView(context: Context) -> WKWebView {
        let webView = NativeIOSHost.makeWebView(
            allowing: url,
            options: .init(deviceInfo: true, networkStatus: true, networkChanges: true)
        )
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}
}
#else
private struct ReleaseWebDemo: UIViewRepresentable {
    private let origin = URL(string: "https://app.example.test/")!

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator

        do {
            guard let resource = Bundle.main.url(forResource: "ReleaseDemo", withExtension: "html") else {
                webView.loadHTMLString("<p>The bridge demo page is unavailable.</p>", baseURL: nil)
                return webView
            }
            let html = try String(contentsOf: resource, encoding: .utf8)
            let appConfiguration = AppConfiguration()
            let getConfig = try NativeIOSHost.BusinessMethod("acme.app.getConfig") { params in
                guard params.isEmpty else { throw NativeIOSHost.BusinessMethodError.invalidParams }
                return await appConfiguration.read()
            }
            context.coordinator.attachment = try NativeIOSHost.attach(
                to: webView, allowing: origin, options: .init(deviceInfo: true), methods: [getConfig]
            )
            // Only the app's bundled HTML is loaded with this base URL.
            webView.loadHTMLString(html, baseURL: origin)
        } catch {
            webView.loadHTMLString("<p>The bridge demo could not start.</p>", baseURL: nil)
        }
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.attachment?.detach()
        coordinator.attachment = nil
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        var attachment: NativeIOSHost.Attachment?

        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
            attachment?.didCommitNavigation()
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            attachment?.webContentProcessDidTerminate()
        }
    }
}

private actor AppConfiguration {
    func read() -> [String: String] { ["theme": "system"] }
}
#endif

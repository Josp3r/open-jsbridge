import NativeIOSHost
import SwiftUI
import WebKit

@main
struct IOSSDKConsumerApp: App {
    var body: some Scene {
        WindowGroup { ConsumerWebView() }
    }
}

private struct ConsumerWebView: UIViewRepresentable {
    private let origin = URL(string: "https://sdk-consumer.example.test")!

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator

        do {
            guard let resource = Bundle.main.url(forResource: "ReleaseToast", withExtension: "html") else {
                throw CocoaError(.fileNoSuchFile)
            }
            let html = try String(contentsOf: resource, encoding: .utf8)
            context.coordinator.attachment = try NativeIOSHost.attach(
                to: webView, allowing: origin, options: .init(deviceInfo: true, toast: true, media: true)
            )
            // This offline example assigns the HTTPS base URL to the bundled page.
            webView.loadHTMLString(html, baseURL: origin)
        } catch {
            webView.loadHTMLString("<p>The SDK consumer could not load its bundled page.</p>", baseURL: nil)
        }
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.attachment?.detach()
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

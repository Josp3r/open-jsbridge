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
            Text("Run the Debug configuration to load the local Web demo.")
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
#endif

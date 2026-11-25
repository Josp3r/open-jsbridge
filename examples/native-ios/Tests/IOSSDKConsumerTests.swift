import UIKit
import WebKit
import XCTest

final class IOSSDKConsumerTests: XCTestCase {
    @MainActor
    func testSharedH5ShowsNativeToastInReleaseApp() async throws {
        let webView = try await waitForConsumerPage()
        let result = try await webView.callAsyncJavaScript(
            "return await window.__sdkToastProbe();", arguments: [:], in: nil, contentWorld: .page
        ) as? [String: String]
        XCTAssertEqual(result?["status"], "passed")
        XCTAssertEqual(result?["os"], "ios")
        let text = "Open JSBridge native toast"
        XCTAssertEqual(result?["text"], text)

        let toast = try XCTUnwrap(findLabel(in: webView, text: text))
        XCTAssertNotNil(toast.window)
        XCTAssertFalse(toast.isHidden)
        XCTAssertGreaterThan(toast.alpha, 0)
        XCTAssertTrue(toast.isAccessibilityElement)
        XCTAssertGreaterThan(toast.convert(toast.bounds, to: webView).midY, webView.bounds.midY)

        for _ in 0..<60 {
            if toast.window == nil { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTFail("The native toast did not dismiss itself")
    }

    @MainActor
    private func waitForConsumerPage() async throws -> WKWebView {
        for _ in 0..<120 {
            for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
                for window in scene.windows where window.isKeyWindow {
                    guard let webView = findWebView(in: window) else { continue }
                    let ready = try? await webView.callAsyncJavaScript(
                        "return typeof window.__sdkToastProbe === 'function';",
                        arguments: [:], in: nil, contentWorld: .page
                    ) as? Bool
                    if ready == true { return webView }
                }
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        return try XCTUnwrap(nil, "The bundled SDK consumer H5 page did not start")
    }

    @MainActor
    private func findWebView(in view: UIView) -> WKWebView? {
        if let webView = view as? WKWebView { return webView }
        for child in view.subviews {
            if let webView = findWebView(in: child) { return webView }
        }
        return nil
    }

    @MainActor
    private func findLabel(in view: UIView, text: String) -> UILabel? {
        if let label = view as? UILabel, label.text == text { return label }
        for child in view.subviews {
            if let label = findLabel(in: child, text: text) { return label }
        }
        return nil
    }
}

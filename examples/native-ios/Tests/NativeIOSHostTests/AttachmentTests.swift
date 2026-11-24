import NativeIOSHost
import WebKit
import XCTest

final class AttachmentTests: XCTestCase {
    @MainActor
    func testRequiresAnExactHTTPSOrigin() async throws {
        let webView = WKWebView(frame: .zero, configuration: configuration())
        let invalidOrigins = [
            "http://127.0.0.1:4173",
            "https://user:secret@bridge.example.com",
            "https://[bridge.example.com]",
            "https://%5Bbridge.example.com%5D",
            "https://%2F",
            "https://bridge.example.com/app",
            "https://bridge.example.com/?",
            "https://bridge.example.com/#",
            "https://bridge.example.com:65536",
            "https://bridge.example.com:18446744073709551616",
            "https://127.001",
            "https://0x7f000001"
        ]

        for raw in invalidOrigins {
            let origin = try XCTUnwrap(URL(string: raw))
            XCTAssertThrowsError(try NativeIOSHost.attach(to: webView, allowing: origin), raw) { error in
                XCTAssertEqual(error as? NativeIOSHost.AttachmentError, .invalidOrigin)
            }
        }

        let origin = try XCTUnwrap(URL(string: "https://bridge.example.com:8443/"))
        let attachment = try NativeIOSHost.attach(to: webView, allowing: origin)
        attachment.detach()
    }

    @MainActor
    func testShimUsesCanonicalIPv6Origin() async throws {
        let configuration = configuration()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        let cases = [
            ("https://[2001:0DB8:0:0::1]", "https://[2001:db8::1]"),
            ("https://[::FFFF:192.0.2.1]", "https://[::ffff:c000:201]")
        ]
        for (raw, canonical) in cases {
            let origin = try XCTUnwrap(URL(string: raw))
            let attachment = try NativeIOSHost.attach(to: webView, allowing: origin)
            let shim = try XCTUnwrap(configuration.userContentController.userScripts.last?.source)
            let encoded = String(decoding: try JSONEncoder().encode(canonical), as: UTF8.self)
            XCTAssertTrue(shim.contains(encoded), "Expected the security origin \(canonical) in the shim")
            attachment.detach()
        }
    }

    @MainActor
    func testRejectsSharedControllerUntilDetach() async throws {
        let configuration = configuration()
        let controller = configuration.userContentController
        let firstView = WKWebView(frame: .zero, configuration: configuration)
        let secondView = WKWebView(frame: .zero, configuration: configuration)
        let origin = try XCTUnwrap(URL(string: "https://bridge.example.com"))
        let attachment = try NativeIOSHost.attach(to: firstView, allowing: origin)

        for view in [firstView, secondView] {
            XCTAssertThrowsError(try NativeIOSHost.attach(to: view, allowing: origin)) { error in
                XCTAssertEqual(error as? NativeIOSHost.AttachmentError, .alreadyAttached)
            }
        }

        attachment.detach()
        let nextAttachment = try NativeIOSHost.attach(to: secondView, allowing: origin)
        attachment.detach()
        XCTAssertThrowsError(try NativeIOSHost.attach(to: firstView, allowing: origin)) { error in
            XCTAssertEqual(error as? NativeIOSHost.AttachmentError, .alreadyAttached)
        }
        nextAttachment.detach()
        XCTAssertTrue(controller.userScripts.isEmpty)
    }

    @MainActor
    func testDetachRestoresAppScriptsInOrderAcrossRepeatedAttachments() async throws {
        let configuration = configuration()
        let controller = configuration.userContentController
        let webView = WKWebView(frame: .zero, configuration: configuration)
        let origin = try XCTUnwrap(URL(string: "https://bridge.example.com"))
        let firstScript = WKUserScript(source: "window.beforeAttach = true", injectionTime: .atDocumentStart,
                                       forMainFrameOnly: true)
        let secondScript = WKUserScript(source: "window.duringAttach = true", injectionTime: .atDocumentEnd,
                                        forMainFrameOnly: false)
        controller.addUserScript(firstScript)
        let attachment = try NativeIOSHost.attach(to: webView, allowing: origin)
        controller.addUserScript(secondScript)

        attachment.detach()
        attachment.detach()
        XCTAssertEqual(controller.userScripts, [firstScript, secondScript])
        let nextAttachment = try NativeIOSHost.attach(to: webView, allowing: origin)
        nextAttachment.detach()
        XCTAssertEqual(controller.userScripts, [firstScript, secondScript])
    }

    @MainActor
    func testDuplicateBusinessMethodLeavesControllerAvailable() async throws {
        let configuration = configuration()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        let origin = try XCTUnwrap(URL(string: "https://bridge.example.com"))
        let method = try NativeIOSHost.BusinessMethod("acme.app.getConfig") { _ in ["theme": "system"] }

        XCTAssertThrowsError(try NativeIOSHost.attach(to: webView, allowing: origin, methods: [method, method])) { error in
            guard case .duplicateName("acme.app.getConfig") = error as? NativeIOSHost.BusinessMethodError else {
                return XCTFail("Expected duplicate business method name, received \(error)")
            }
        }
        XCTAssertTrue(configuration.userContentController.userScripts.isEmpty)
        let attachment = try NativeIOSHost.attach(to: webView, allowing: origin, methods: [method])
        attachment.detach()
    }

    #if DEBUG
    @MainActor
    func testDemoViewCannotBeAttachedToASecondBridge() async throws {
        let origin = try XCTUnwrap(URL(string: "https://bridge.example.com"))
        let webView = NativeIOSHost.makeWebView(allowing: origin)
        XCTAssertThrowsError(try NativeIOSHost.attach(to: webView, allowing: origin)) { error in
            XCTAssertEqual(error as? NativeIOSHost.AttachmentError, .alreadyAttached)
        }
    }
    #endif

    @MainActor
    private func configuration() -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        return configuration
    }
}

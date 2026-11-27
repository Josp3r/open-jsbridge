import Foundation
import XCTest
@testable import NativeIOSHost

final class UploadRequestTests: XCTestCase {
    private let origin = URL(string: "https://app.example")!
    private let destination = URL(string: "https://upload.example:443/v1/avatar")!
    private let handle = "0123456789abcdef0123456789abcdef"

    private func parse(_ extra: [String: Any] = [:]) throws -> UploadRequest {
        let endpoint = try NativeIOSHost.UploadEndpoint(
            origin: origin, url: destination, fileFields: ["file", "image"],
            formFields: ["purpose"], headerNames: ["X-Label"], hostHeaders: ["Authorization": "host credential"]
        )
        var request: [String: Any] = ["url": destination.absoluteString]
        request.merge(extra) { _, value in value }
        return try UploadRequest.parse(["id": handle, "request": request], endpoints: [endpoint])
    }

    private func expect(_ code: Int, _ operation: @autoclosure () throws -> UploadRequest,
                        file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try operation(), file: file, line: line) {
            XCTAssertEqual(($0 as? UploadFailure)?.code, code, file: file, line: line)
        }
    }

    func testUsesRegisteredEndpointHostCredentialsAndCompressionDefaults() throws {
        let defaults = try parse()
        XCTAssertEqual(defaults.id, handle)
        XCTAssertEqual(defaults.url.absoluteString, destination.absoluteString)
        XCTAssertEqual(defaults.fieldName, "file")
        XCTAssertEqual(defaults.maxEdge, 2048)
        XCTAssertEqual(defaults.quality, 80)
        let request = try parse(["method": "POST", "fieldName": "image", "formData": ["purpose": "头像"],
                                 "headers": ["x-label": "sample"], "compress": ["quality": 1, "maxEdge": 4096]])
        XCTAssertEqual(request.quality, 1)
        XCTAssertEqual(request.maxEdge, 4096)
        XCTAssertEqual(request.fieldName, "image")
        XCTAssertEqual(request.formData, ["purpose": "头像"])
        XCTAssertEqual(request.headers["x-label"], "sample")
        XCTAssertEqual(request.headers["Authorization"], "host credential")
    }

    func testEndpointMustMatchWholeConfiguredString() throws {
        for url in ["https://upload.example/v1/avatar", "https://upload.example:443/v1/avatar/",
                    "https://upload.example:443/v1/%61vatar", "https://upload.example:443/v1/other"] {
            expect(-32003, try parse(["url": url]))
        }
        for url in ["http://upload.example", "https://user@upload.example/v1/avatar",
                    "https://upload.example/v1/avatar?q", "https://upload.example/v1/avatar#fragment",
                    "relative/path"] {
            expect(-32602, try parse(["url": url]))
        }
        expect(-32003, try UploadRequest.parse(["id": handle, "request": ["url": destination.absoluteString]], endpoints: []))
    }

    func testRejectsUnapprovedFieldsHeadersAndCaseInsensitiveCredentialOverrides() throws {
        expect(-32003, try parse(["fieldName": "other"]))
        expect(-32003, try parse(["formData": ["Other": "x"]]))
        for key in ["AUTHORIZATION", "proxy-Authorization", "Cookie", "Host", "Content-Disposition",
                    "Transfer-Encoding", "Connection", "X-Other"] {
            expect(-32003, try parse(["headers": [key: "value"]]))
        }
        expect(-32602, try parse(["headers": ["X-Label": "", "x-label": ""]]))
        expect(-32602, try parse(["headers": ["X-Label": "a\r\nb"]]))
        expect(-32602, try parse(["formData": ["image": "value"], "fieldName": "image"]))
    }

    func testEnforcesCombinedUTF8BudgetAndMapEntryLimit() throws {
        // 7 bytes for "purpose", 7 for "X-Label", 2 per é.
        let text = String(repeating: "é", count: 8185)
        XCTAssertNoThrow(try parse(["formData": ["purpose": text], "headers": ["X-Label": ""]]))
        expect(-32006, try parse(["formData": ["purpose": text], "headers": ["X-Label": "x"]]))
        let tooMany = Dictionary(uniqueKeysWithValues: (0..<17).map { ("f\($0)", "x") })
        expect(-32006, try parse(["headers": tooMany]))
        expect(-32006, try parse(["formData": tooMany]))
    }

    func testRejectsMalformedWireTypesAndUnknownOptions() throws {
        for extra: [String: Any] in [["timeout": 1000], ["method": "PUT"], ["headers": NSNull()],
                                      ["fieldName": NSNull()], ["formData": ["purpose": 1]],
                                      ["fieldName": "line\n"], ["headers": ["bad key": "value"]],
                                      ["compress": NSNull()], ["compress": ["quality": true]],
                                      ["compress": ["quality": 1.2]], ["compress": ["maxEdge": "20"]],
                                      ["compress": ["maxEdge": 0]], ["compress": ["q": 90]]] {
            expect(-32602, try parse(extra))
        }
        let request = ["url": destination.absoluteString]
        expect(-32602, try UploadRequest.parse(["id": handle.uppercased(), "request": request], endpoints: []))
        expect(-32602, try UploadRequest.parse(["id": handle, "request": request, "other": true], endpoints: []))
    }

    func testRejectsUnsafeEndpointConfigurationBeforeInstallation() throws {
        for address in ["http://upload.example/v1", "https://user@upload.example/v1",
                        "https://upload.example/v1?", "https://upload.example/v1#"] {
            XCTAssertThrowsError(try NativeIOSHost.UploadEndpoint(origin: origin, url: XCTUnwrap(URL(string: address))))
        }
        XCTAssertThrowsError(try NativeIOSHost.UploadEndpoint(origin: destination, url: destination))
        XCTAssertThrowsError(try NativeIOSHost.UploadEndpoint(origin: origin, url: destination, headerNames: ["cookie"]))
        XCTAssertThrowsError(try NativeIOSHost.UploadEndpoint(origin: origin, url: destination, headerNames: ["X-Token"],
                                                              hostHeaders: ["x-token": "native"]))
        XCTAssertThrowsError(try NativeIOSHost.UploadEndpoint(origin: origin, url: destination, hostHeaders: ["Host": "elsewhere"]))
        XCTAssertThrowsError(try NativeIOSHost.UploadEndpoint(origin: origin, url: destination,
                                                              hostHeaders: ["X-Token": "bad\nheader"]))
    }
}

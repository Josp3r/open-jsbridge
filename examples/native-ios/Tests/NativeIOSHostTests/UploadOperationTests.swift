import XCTest
@testable import NativeIOSHost

final class UploadOperationTests: XCTestCase {
    private let origin = URL(string: "https://app.example")!
    private let url = URL(string: "https://uploads.example/avatar")!

    private final class ManualTimer {
        var fire: (() -> Void)?

        func schedule(_ deadline: DispatchTime, _ action: @escaping () -> Void) -> () -> Void {
            fire = action
            return { [weak self] in self?.fire = nil }
        }
    }

    private func source(in store: MediaStore, confirm: (@MainActor (String) async -> Bool)? = nil) throws -> UploadRequest {
        let image = try MediaImage.prepare(data: makeMediaJPEG(width: 24, height: 12), mime: "image/jpeg")
        let file = try store.insert(image)
        let endpoint = try NativeIOSHost.UploadEndpoint(origin: origin, url: url, confirm: confirm)
        return try UploadRequest.parse(["id": try XCTUnwrap(file["id"] as? String),
                                        "request": ["url": url.absoluteString]], endpoints: [endpoint])
    }

    @MainActor
    func testDecliningNativeConfirmationStopsBeforeNetworkAndPreservesTheSource() async throws {
        let store = MediaStore()
        var asked: [String] = []
        let request = try source(in: store) { id in asked.append(id); return false }
        var sends = 0
        let operation = try UploadOperation(request: request, media: store, timeout: 5000, isForeground: { true }) { _, _, _, _ in
            sends += 1
            return ["status": 201, "body": ""]
        }
        do {
            _ = try await operation.run(progress: .init { _ in false })
            XCTFail("Declined upload succeeded")
        } catch {
            XCTAssertEqual((error as? UploadFailure)?.code, -32007)
        }
        XCTAssertEqual(asked, [request.id])
        XCTAssertEqual(sends, 0)
        XCTAssertNotNil(store.bytes(for: request.id))
    }

    @MainActor
    func testReleasedOrForeignHandleAndBackgroundNeverStartAnUpload() throws {
        let store = MediaStore()
        let request = try source(in: store)
        XCTAssertThrowsError(try UploadOperation(request: request, media: MediaStore(), timeout: 100, isForeground: { true })) {
            XCTAssertEqual(($0 as? UploadFailure)?.code, -32003)
        }
        XCTAssertThrowsError(try UploadOperation(request: request, media: store, timeout: 100, isForeground: { false })) {
            XCTAssertEqual(($0 as? UploadFailure)?.code, -32003)
        }
        store.discard(request.id)
        XCTAssertThrowsError(try UploadOperation(request: request, media: store, timeout: 100, isForeground: { true })) {
            XCTAssertEqual(($0 as? UploadFailure)?.code, -32003)
        }
    }

    @MainActor
    func testReleaseWinsOverLateCancellationAndPreventsNetworkStart() async throws {
        let store = MediaStore()
        let request = try source(in: store)
        let op = try UploadOperation(request: request, media: store, timeout: 1000, isForeground: { true }) { _, _, _, _ in
            XCTFail("Released image reached the network")
            return [:]
        }
        store.discard(request.id)
        op.cancel(UploadFailure(-32002, "cancelled"))
        do {
            _ = try await op.run(progress: .init { _ in false })
            XCTFail("Revoked upload succeeded")
        } catch { XCTAssertEqual((error as? UploadFailure)?.code, -32003) }
    }

    @MainActor
    func testTimeoutCancelsInFlightTransportAndSourceCanBeUploadedAgain() async throws {
        let store = MediaStore()
        let request = try source(in: store)
        let timer = ManualTimer()
        let started = expectation(description: "Network task started")
        let cancelled = expectation(description: "Network task cancelled")
        let op = try UploadOperation(request: request, media: store, timeout: 60_000, isForeground: { true },
                                     schedule: timer.schedule) { _, _, _, authorize in
            try authorize()
            started.fulfill()
            do { try await Task.sleep(nanoseconds: 10_000_000_000) } catch {
                cancelled.fulfill()
                throw error
            }
            return [:]
        }
        let active = Task { @MainActor in try await op.run(progress: .init { _ in false }) }
        await fulfillment(of: [started], timeout: 10)
        try XCTUnwrap(timer.fire)()
        do {
            _ = try await active.value
            XCTFail("Stalled upload succeeded")
        } catch { XCTAssertEqual((error as? UploadFailure)?.code, -32001) }
        await fulfillment(of: [cancelled], timeout: 2)
        let retry = try UploadOperation(request: request, media: store, timeout: 1000, isForeground: { true }) { _, jpeg, _, authorize in
            try authorize()
            XCTAssertEqual(Array(jpeg.prefix(2)), [0xff, 0xd8])
            return ["status": 201, "body": ""]
        }
        let response = try await retry.run(progress: .init { _ in false }) as? [String: Any]
        XCTAssertEqual(response?["status"] as? Int, 201)
    }

    @MainActor
    func testHandleExpiresWhileWaitingForHTTPResponse() async throws {
        let timer = ManualTimer()
        let store = MediaStore(schedule: timer.schedule)
        let request = try source(in: store)
        let started = expectation(description: "Waiting for HTTP")
        let cancelled = expectation(description: "Expired upload cancelled")
        let op = try UploadOperation(request: request, media: store, timeout: 60_000, isForeground: { true }) { _, _, _, authorize in
            try authorize()
            started.fulfill()
            do { try await Task.sleep(nanoseconds: 10_000_000_000) } catch {
                cancelled.fulfill()
                throw error
            }
            return [:]
        }
        let active = Task { @MainActor in try await op.run(progress: .init { _ in false }) }
        await fulfillment(of: [started], timeout: 10)
        try XCTUnwrap(timer.fire)()
        do {
            _ = try await active.value
            XCTFail("Expired upload succeeded")
        } catch { XCTAssertEqual((error as? UploadFailure)?.code, -32003) }
        await fulfillment(of: [cancelled], timeout: 2)
    }

    @MainActor
    func testRechecksForegroundImmediatelyBeforeNetworkSideEffect() async throws {
        let store = MediaStore()
        let request = try source(in: store)
        var foreground = true
        let op = try UploadOperation(request: request, media: store, timeout: 1000, isForeground: { foreground }) { _, _, _, authorize in
            foreground = false
            // The body stream can finish unwinding after another message has released this image.
            defer { store.discard(request.id) }
            try authorize()
            XCTFail("Network start authorized in background")
            return [:]
        }
        do {
            _ = try await op.run(progress: .init { _ in false })
            XCTFail("Background upload succeeded")
        } catch { XCTAssertEqual((error as? UploadFailure)?.code, -32002) }
    }
}

import Foundation
import Security

enum MediaSelection {
    case cancelled
    case selected(MediaImage)
}

enum MediaProfileError: Error {
    case unavailable
    case busy
    case tooLarge
}

/// Starts a one-shot main-queue timer and returns its cancellation.
typealias ScheduleDeadline = (DispatchTime, @escaping () -> Void) -> () -> Void

func scheduleDeadline(_ deadline: DispatchTime, _ fire: @escaping () -> Void) -> () -> Void {
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: deadline)
    timer.setEventHandler(handler: fire)
    timer.resume()
    return { timer.cancel() }
}

/// Privately retains selected originals for one verified document session.
final class MediaStore {
    static let chooseMethod = "media.chooseMedia"
    static let releaseMethod = "media.release"
    static let maxBytes = 20 * 1024 * 1024
    private static let lifetimeMilliseconds = 300_000
    private let schedule: ScheduleDeadline

    /// Held by an upload while it can read a selected original. The store does not own the upload.
    final class UploadLease {
        fileprivate let id: String
        fileprivate let invalidate: () -> Void

        fileprivate init(id: String, invalidate: @escaping () -> Void) {
            self.id = id
            self.invalidate = invalidate
        }
    }

    private struct Entry {
        let bytes: Data
        let expiresAt: Int64
        let deadline: DispatchTime
        let cancelExpiry: () -> Void
    }

    private var entries: [String: Entry] = [:]
    private var savedBytes = 0
    private weak var upload: UploadLease?

    init(schedule: @escaping ScheduleDeadline = scheduleDeadline) {
        self.schedule = schedule
    }

    func insert(_ image: MediaImage) throws -> [String: Any] {
        guard !image.data.isEmpty, image.width > 0, image.height > 0,
              !image.thumbnail.isEmpty, image.thumbnail.count <= MediaImage.maxThumbnailBytes,
              image.mime.utf8.count <= 128,
              image.mime.range(of: #"\Aimage/[a-zA-Z0-9!#$&^_.+\-]+\z"#, options: .regularExpression) != nil else {
            throw MediaProfileError.unavailable
        }
        let now = Self.currentTime
        for id in entries.filter({ $0.value.expiresAt <= now }).keys { discard(id) }
        guard image.data.count <= Self.maxBytes - savedBytes else { throw MediaProfileError.tooLarge }

        var random = [UInt8](repeating: 0, count: 16)
        guard SecRandomCopyBytes(kSecRandomDefault, random.count, &random) == errSecSuccess else {
            throw MediaProfileError.unavailable
        }
        let id = random.map { String(format: "%02x", $0) }.joined()
        guard entries[id] == nil else { throw MediaProfileError.unavailable }
        let expiresAt = now + Int64(Self.lifetimeMilliseconds)
        let deadline = DispatchTime.now() + .milliseconds(Self.lifetimeMilliseconds)
        let cancelExpiry = schedule(deadline) { [weak self] in self?.discard(id) }
        entries[id] = Entry(bytes: image.data, expiresAt: expiresAt, deadline: deadline, cancelExpiry: cancelExpiry)
        savedBytes += image.data.count
        return [
            "type": "image", "id": id, "mime": image.mime, "size": image.data.count,
            "width": image.width, "height": image.height, "expiresAt": expiresAt,
            "thumbnailBase64": image.thumbnail.base64EncodedString()
        ]
    }

    func lease(_ id: String, onInvalidation: @escaping () -> Void) throws -> UploadLease {
        guard bytes(for: id) != nil else { throw UploadFailure(-32003, "invalid_handle") }
        guard upload == nil else { throw UploadFailure(-32010, "busy") }
        let lease = UploadLease(id: id, invalidate: onInvalidation)
        upload = lease
        return lease
    }

    func bytes(for id: String) -> Data? {
        guard let entry = entries[id] else { return nil }
        guard entry.expiresAt > Self.currentTime, DispatchTime.now() < entry.deadline else {
            discard(id)
            return nil
        }
        return entry.bytes
    }

    func discard(_ id: String) {
        guard let entry = entries.removeValue(forKey: id) else { return }
        savedBytes -= entry.bytes.count
        entry.cancelExpiry()
        if let upload, upload.id == id { upload.invalidate() }
    }

    func reset() {
        entries.values.forEach { $0.cancelExpiry() }
        entries.removeAll()
        savedBytes = 0
        upload?.invalidate()
    }

    private static var currentTime: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}

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

/// Privately retains selected originals for one verified document session.
final class MediaStore {
    static let chooseMethod = "media.chooseMedia"
    static let maxBytes = 20 * 1024 * 1024
    private static let lifetimeSeconds = 300

    private struct Entry {
        let bytes: Data
        let expiresAt: Int64
        let expiry: DispatchWorkItem
    }

    private var entries: [String: Entry] = [:]
    private var savedBytes = 0

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
        let expiresAt = now + Int64(Self.lifetimeSeconds * 1000)
        let expiry = DispatchWorkItem { [weak self] in self?.discard(id) }
        entries[id] = Entry(bytes: image.data, expiresAt: expiresAt, expiry: expiry)
        savedBytes += image.data.count
        DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(Self.lifetimeSeconds), execute: expiry)
        return [
            "type": "image", "id": id, "mime": image.mime, "size": image.data.count,
            "width": image.width, "height": image.height, "expiresAt": expiresAt,
            "thumbnailBase64": image.thumbnail.base64EncodedString()
        ]
    }

    func discard(_ id: String) {
        guard let entry = entries.removeValue(forKey: id) else { return }
        savedBytes -= entry.bytes.count
        entry.expiry.cancel()
    }

    func reset() {
        entries.values.forEach { $0.expiry.cancel() }
        entries.removeAll()
        savedBytes = 0
    }

    private static var currentTime: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}

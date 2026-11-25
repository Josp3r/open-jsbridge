import Foundation
import Security

struct MediaImage {
    let data: Data
    let mime: String
}

enum MediaSelection {
    case cancelled
    case selected(MediaImage)
}

enum MediaProfileError: Error {
    case unavailable
    case busy
    case tooLarge
    case invalidIndex
    case unknownReference
}

/// Read and updated on the main queue by the WebKit host and the expiry timer.
final class MediaBlobStore {
    static let chooseMethod = "media.chooseMedia"
    static let readMethod = "bridge.blob.read"
    static let releaseMethod = "bridge.blob.release"
    static let maxBytes = 20 * 1024 * 1024
    static let chunkBytes = 64 * 1024
    static let maxChunks = Int64(maxBytes / chunkBytes)
    private static let lifetimeSeconds = 300

    private struct Entry {
        let bytes: Data
        let expiresAt: Int64
        let expiry: DispatchWorkItem
    }

    private var entries: [String: Entry] = [:]
    private var savedBytes = 0

    func insert(_ image: MediaImage) throws -> [String: Any] {
        guard !image.data.isEmpty, image.mime.utf8.count <= 128,
              image.mime.range(of: #"\Aimage/[a-zA-Z0-9!#$&^_.+\-]+\z"#, options: .regularExpression) != nil else {
            throw MediaProfileError.unavailable
        }
        let now = Self.currentTime
        for ref in entries.filter({ $0.value.expiresAt <= now }).keys { release(ref) }
        guard image.data.count <= Self.maxBytes - savedBytes else { throw MediaProfileError.tooLarge }

        var random = [UInt8](repeating: 0, count: 16)
        guard SecRandomCopyBytes(kSecRandomDefault, random.count, &random) == errSecSuccess else {
            throw MediaProfileError.unavailable
        }
        let ref = random.map { String(format: "%02x", $0) }.joined()
        guard entries[ref] == nil else { throw MediaProfileError.unavailable }
        let expiresAt = now + Int64(Self.lifetimeSeconds * 1000)
        let expiry = DispatchWorkItem { [weak self] in self?.release(ref) }
        entries[ref] = Entry(bytes: image.data, expiresAt: expiresAt, expiry: expiry)
        savedBytes += image.data.count
        DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(Self.lifetimeSeconds), execute: expiry)
        return ["type": "image", "blobRef": ref, "mime": image.mime, "size": image.data.count, "expiresAt": expiresAt]
    }

    func read(_ ref: String, index: Int64) throws -> [String: Any] {
        guard let entry = entries[ref] else { throw MediaProfileError.unknownReference }
        guard entry.expiresAt > Self.currentTime else {
            release(ref)
            throw MediaProfileError.unknownReference
        }
        guard index >= 0, index <= Int64((entry.bytes.count - 1) / Self.chunkBytes) else {
            throw MediaProfileError.invalidIndex
        }
        let start = Int(index) * Self.chunkBytes
        let end = min(start + Self.chunkBytes, entry.bytes.count)
        let data = entry.bytes.dropFirst(start).prefix(end - start)
        return ["dataBase64": data.base64EncodedString(), "done": end == entry.bytes.count]
    }

    func release(_ ref: String) {
        guard let entry = entries.removeValue(forKey: ref) else { return }
        savedBytes -= entry.bytes.count
        entry.expiry.cancel()
    }

    func reset() {
        entries.values.forEach { $0.expiry.cancel() }
        entries.removeAll()
        savedBytes = 0
    }

    static func isRef(_ value: String) -> Bool {
        value.utf8.count == 32 && value.utf8.allSatisfy {
            (48...57).contains($0) || (97...102).contains($0)
        }
    }

    private static var currentTime: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}

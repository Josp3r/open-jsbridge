import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum UploadImage {
    // ImageIO can also rasterize documents. Accept recognized photo containers by their
    // decoder-reported identifiers, even when the system type registry is unavailable.
    private static let rasterTypes: Set<String> = [
        UTType.jpeg.identifier, UTType.png.identifier, UTType.heic.identifier, UTType.heif.identifier,
        UTType.tiff.identifier, UTType.gif.identifier, UTType.webP.identifier, UTType.bmp.identifier,
        "public.avif", "public.jpeg-2000"
    ]

    enum Failure: Error, Equatable {
        case invalidParameters, unsupportedImage, tooLarge, encodingFailed
    }

    /// Prepares the file part of a foreground upload. Run on the host's image-processing queue.
    static func prepare(data: Data, maxEdge: Int = 2048, quality: Int = 80,
                        isCancelled: @escaping () -> Bool = { false }) throws -> Data {
        guard !isCancelled() else { throw CancellationError() }
        guard (1...4096).contains(maxEdge), (1...100).contains(quality) else {
            throw Failure.invalidParameters
        }
        guard data.count <= MediaStore.maxBytes else { throw Failure.tooLarge }

        let sampled = try orientedImage(from: data, maxEdge: maxEdge)
        guard !isCancelled() else { throw CancellationError() }
        let pixels = try opaquePixels(from: sampled)
        guard !isCancelled() else { throw CancellationError() }
        return try JPEGOutput(isCancelled: isCancelled).encode(pixels, quality: quality)
    }

    private static func orientedImage(from data: Data, maxEdge: Int) throws -> CGImage {
        let options = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, options),
              CGImageSourceGetStatus(source) == .statusComplete,
              CGImageSourceGetCount(source) == 1,
              let identifier = CGImageSourceGetType(source), rasterTypes.contains(identifier as String),
              (identifier as String) != UTType.jpeg.identifier || hasJPEGEndOfImage(data),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int, width > 0,
              let height = properties[kCGImagePropertyPixelHeight] as? Int, height > 0 else {
            throw Failure.unsupportedImage
        }
        let limit = min(maxEdge, max(width, height))
        let thumbnailOptions: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: limit
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions as CFDictionary),
              CGImageSourceGetStatusAtIndex(source, 0) == .statusComplete,
              image.width <= limit, image.height <= limit else { throw Failure.unsupportedImage }
        return image
    }

    /// ImageIO can recover a truncated JPEG scan and report it as complete. Walk the
    /// markers so an embedded thumbnail's EOI cannot stand in for the original's.
    private static func hasJPEGEndOfImage(_ data: Data) -> Bool {
        data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
            guard bytes.count >= 4, bytes[0] == 0xff, bytes[1] == 0xd8,
                  let base = bytes.baseAddress else { return false }
            var offset = 2
            var sawScan = false
            while offset < bytes.count,
                  let next = memchr(base.advanced(by: offset), 0xff, bytes.count - offset) {
                offset = base.distance(to: next) + 1
                while offset < bytes.count && bytes[offset] == 0xff { offset += 1 }
                guard offset < bytes.count else { return false }
                let marker = bytes[offset]
                offset += 1
                switch marker {
                case 0xd9: return sawScan
                case 0x00, 0x01, 0xd0...0xd7: continue  // Stuffed byte, TEM or restart marker.
                default:
                    // Length includes the length field itself. Skip metadata and scan headers.
                    guard offset + 2 <= bytes.count else { return false }
                    let length = Int(bytes[offset]) * 256 + Int(bytes[offset + 1])
                    guard length >= 2, length <= bytes.count - offset else { return false }
                    if marker == 0xda { sawScan = true }
                    offset += length
                }
            }
            return false
        }
    }

    private static func opaquePixels(from image: CGImage) throws -> CGImage {
        // A new sRGB bitmap carries only pixels into the JPEG, including for transparent inputs.
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: image.width, height: image.height,
                                      bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
            throw Failure.encodingFailed
        }
        let bounds = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        context.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
        context.fill(bounds)
        context.draw(image, in: bounds)
        guard let pixels = context.makeImage() else { throw Failure.encodingFailed }
        return pixels
    }
}

private final class JPEGOutput {
    private static let maxBytes = 20 * 1024 * 1024
    private var data = Data()
    private var failure: Error?
    private let isCancelled: () -> Bool

    init(isCancelled: @escaping () -> Bool) {
        self.isCancelled = isCancelled
    }

    func encode(_ image: CGImage, quality: Int) throws -> Data {
        var callbacks = CGDataConsumerCallbacks(putBytes: { info, buffer, count in
            guard let info else { return 0 }
            return Unmanaged<JPEGOutput>.fromOpaque(info).takeUnretainedValue().write(buffer, count: count)
        }, releaseConsumer: { info in
            if let info { Unmanaged<JPEGOutput>.fromOpaque(info).release() }
        })
        let owner = Unmanaged.passRetained(self)
        guard let consumer = CGDataConsumer(info: owner.toOpaque(), cbks: &callbacks) else {
            owner.release()
            throw UploadImage.Failure.encodingFailed
        }
        guard let destination = CGImageDestinationCreateWithDataConsumer(
            consumer, UTType.jpeg.identifier as CFString, 1, nil
        ) else {
            throw UploadImage.Failure.encodingFailed
        }
        let options = [kCGImageDestinationLossyCompressionQuality: Double(quality) / 100] as CFDictionary
        CGImageDestinationAddImage(destination, image, options)
        let finalized = CGImageDestinationFinalize(destination)
        if let failure { throw failure }
        guard !isCancelled() else { throw CancellationError() }
        guard finalized, !data.isEmpty else { throw UploadImage.Failure.encodingFailed }
        return data
    }

    private func write(_ bytes: UnsafeRawPointer, count: Int) -> Int {
        guard failure == nil else { return 0 }
        if isCancelled() {
            failure = CancellationError()
        } else if count > Self.maxBytes - data.count {
            failure = UploadImage.Failure.tooLarge
        } else {
            data.append(bytes.assumingMemoryBound(to: UInt8.self), count: count)
            return count
        }
        data = Data()
        return 0
    }
}

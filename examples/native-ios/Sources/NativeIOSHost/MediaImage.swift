import Foundation
import ImageIO
import UniformTypeIdentifiers

struct MediaImage {
    static let maxThumbnailBytes = 32 * 1024

    let data: Data
    let mime: String
    let width: Int
    let height: Int
    let thumbnail: Data

    /// Runs on the picker import queue. ImageIO decodes a display-oriented thumbnail.
    static func prepare(data: Data, mime: String, isCancelled: () -> Bool = { false }) throws -> MediaImage {
        guard !isCancelled() else { throw CancellationError() }
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let pixelWidth = properties[kCGImagePropertyPixelWidth] as? Int, pixelWidth > 0,
              let pixelHeight = properties[kCGImagePropertyPixelHeight] as? Int, pixelHeight > 0 else {
            throw MediaProfileError.unavailable
        }
        let orientation = properties[kCGImagePropertyOrientation] as? Int ?? 1
        let rotatesAxes = (5...8).contains(orientation)
        let originalMIME = CGImageSourceGetType(source)
            .flatMap { UTType($0 as String)?.preferredMIMEType } ?? mime

        for (maxEdge, quality) in [(256, 0.78), (192, 0.64), (128, 0.55), (64, 0.5)] {
            guard !isCancelled() else { throw CancellationError() }
            let options = [
                kCGImageSourceThumbnailMaxPixelSize: maxEdge,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceCreateThumbnailFromImageAlways: true
            ] as CFDictionary
            guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else {
                throw MediaProfileError.unavailable
            }

            let jpeg = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(jpeg, UTType.jpeg.identifier as CFString, 1, nil) else {
                throw MediaProfileError.unavailable
            }
            CGImageDestinationAddImage(destination, image, [
                kCGImageDestinationLossyCompressionQuality: quality
            ] as CFDictionary)
            guard CGImageDestinationFinalize(destination) else { throw MediaProfileError.unavailable }
            if jpeg.length <= maxThumbnailBytes {
                guard !isCancelled() else { throw CancellationError() }
                return MediaImage(data: data, mime: originalMIME,
                                  width: rotatesAxes ? pixelHeight : pixelWidth,
                                  height: rotatesAxes ? pixelWidth : pixelHeight, thumbnail: jpeg as Data)
            }
        }
        throw MediaProfileError.tooLarge
    }
}

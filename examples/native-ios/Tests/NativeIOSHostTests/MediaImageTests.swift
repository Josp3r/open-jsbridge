import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import NativeIOSHost

final class MediaImageTests: XCTestCase {
    func testDownsamplingNormalizesExifOrientationAndBoundsJPEG() throws {
        let original = try makeMediaJPEG(width: 800, height: 640, orientation: 6)
        let image = try MediaImage.prepare(data: original, mime: "image/jpeg")
        XCTAssertEqual(image.width, 640)
        XCTAssertEqual(image.height, 800)
        XCTAssertEqual(image.data, original)
        XCTAssertEqual(image.mime, "image/jpeg")
        XCTAssertLessThanOrEqual(image.thumbnail.count, 32_768)

        let source = try XCTUnwrap(CGImageSourceCreateWithData(image.thumbnail as CFData, nil))
        XCTAssertEqual(CGImageSourceGetType(source) as String?, UTType.jpeg.identifier)
        let thumbnail = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        XCTAssertLessThan(thumbnail.width, thumbnail.height)
        XCTAssertLessThanOrEqual(thumbnail.height, 256)
        XCTAssertEqual(Double(thumbnail.width) / Double(thumbnail.height), 0.8, accuracy: 0.02)
    }

    func testInvalidImageAndCancellationFailWithoutAThumbnail() throws {
        XCTAssertThrowsError(try MediaImage.prepare(data: Data([1, 2, 3]), mime: "image/jpeg"))
        let original = try makeMediaJPEG(width: 8, height: 8)
        XCTAssertThrowsError(try MediaImage.prepare(data: original, mime: "image/jpeg", isCancelled: { true })) {
            XCTAssertTrue($0 is CancellationError)
        }
    }
}

func makeMediaJPEG(width: Int, height: Int, orientation: Int = 1) throws -> Data {
    var state: UInt32 = 5329
    var pixels = Data(count: width * height * 4)
    pixels.withUnsafeMutableBytes { (buffer: UnsafeMutableRawBufferPointer) in
        for offset in stride(from: 0, to: buffer.count, by: 4) {
            state = 1_664_525 &* state &+ 1_013_904_223
            buffer[offset] = UInt8(truncatingIfNeeded: state >> 24)
            buffer[offset + 1] = UInt8(truncatingIfNeeded: state >> 16)
            buffer[offset + 2] = UInt8(truncatingIfNeeded: state >> 8)
            buffer[offset + 3] = 255
        }
    }
    let provider = try XCTUnwrap(CGDataProvider(data: pixels as CFData))
    let image = try XCTUnwrap(CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
        bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent))
    let data = NSMutableData()
    let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, [
        kCGImagePropertyOrientation: orientation,
        kCGImageDestinationLossyCompressionQuality: 0.98
    ] as CFDictionary)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    return data as Data
}

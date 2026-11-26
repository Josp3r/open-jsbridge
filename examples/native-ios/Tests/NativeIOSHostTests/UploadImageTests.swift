import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import NativeIOSHost

final class UploadImageTests: XCTestCase {
    func testSmallImageKeepsItsDimensionsAtDefaultSettings() throws {
        let original = try makeMediaJPEG(width: 87, height: 39)
        let image = try decodeJPEG(UploadImage.prepare(data: original))
        XCTAssertEqual(image.width, 87)
        XCTAssertEqual(image.height, 39)
    }

    func testDefaultLongEdgeAndMinimumEdgePreserveAspectRatioWithinOnePixel() throws {
        let original = try makeMediaJPEG(width: 3072, height: 48)
        let image = try decodeJPEG(UploadImage.prepare(data: original))
        XCTAssertEqual(image.width, 2048)
        XCTAssertEqual(image.height, 32)
        let smallest = try decodeJPEG(UploadImage.prepare(data: original, maxEdge: 1))
        XCTAssertEqual(smallest.width, 1)
        XCTAssertEqual(smallest.height, 1)
    }

    func testRotatedAndMirroredExifProduceUprightJPEGAtRequestedSize() throws {
        let image = try markedImage()
        // Expected colors in reading order, after displaying each EXIF orientation.
        let cases: [(orientation: Int, corners: [Color])] = [
            (1, [.red, .green, .blue, .yellow]),
            (2, [.green, .red, .yellow, .blue]),
            (3, [.yellow, .blue, .green, .red]),
            (4, [.blue, .yellow, .red, .green]),
            (5, [.red, .blue, .green, .yellow]),
            (6, [.blue, .red, .yellow, .green]),
            (7, [.yellow, .green, .blue, .red]),
            (8, [.green, .yellow, .red, .blue])
        ]
        for (orientation, corners) in cases {
            let original = try encode([image], as: .jpeg, properties: [kCGImagePropertyOrientation: orientation])
            let output = try UploadImage.prepare(data: original, maxEdge: 48)
            let jpeg = try decodeJPEG(output)
            XCTAssertEqual(jpeg.width, orientation <= 4 ? 48 : 32, "orientation \(orientation)")
            XCTAssertEqual(jpeg.height, orientation <= 4 ? 32 : 48, "orientation \(orientation)")
            XCTAssertEqual(try properties(of: output)[kCGImagePropertyOrientation] as? Int ?? 1, 1)
            for (index, expected) in corners.enumerated() {
                let x = (index % 2 * 2 + 1) * jpeg.width / 4
                let y = (index / 2 * 2 + 1) * jpeg.height / 4
                try assertPixel(jpeg, x: x, y: y, is: expected, message: "orientation \(orientation), corner \(index)")
            }
        }
    }

    func testPNGCompositesTransparentAndTranslucentPixelsOnWhiteAndRetainsOpaqueColor() throws {
        let context = try bitmap(width: 96, height: 64)
        context.clear(CGRect(x: 0, y: 0, width: 96, height: 64))
        context.setFillColor(red: 1, green: 0, blue: 0, alpha: 0.5)
        context.fill(CGRect(x: 32, y: 0, width: 32, height: 64))
        context.setFillColor(red: 0, green: 0, blue: 1, alpha: 1)
        context.fill(CGRect(x: 64, y: 0, width: 32, height: 64))
        let original = try encode([XCTUnwrap(context.makeImage())], as: .png)
        let jpeg = try decodeJPEG(UploadImage.prepare(data: original))
        try assertPixel(jpeg, x: 16, y: 32, is: .white)
        let blended = try pixelRGB(jpeg, x: 48, y: 32)
        XCTAssertGreaterThan(blended[0], 240)
        // Blending in gamma-encoded or linear sRGB gives different intermediate values.
        XCTAssertTrue((110...200).contains(blended[1]))
        XCTAssertEqual(blended[1], blended[2], accuracy: 12)
        try assertPixel(jpeg, x: 80, y: 32, is: .blue)
    }

    func testDeviceSupportedHEICBecomesJPEG() throws {
        let type = UTType.heic.identifier
        let decoders = CGImageSourceCopyTypeIdentifiers() as? [String] ?? []
        try XCTSkipUnless(decoders.contains(type), "ImageIO has no HEIC decoder")
        let original = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(original, type as CFString, 1, nil) else {
            throw XCTSkip("ImageIO has no encoder for the HEIC fixture")
        }
        CGImageDestinationAddImage(destination, try markedImage(), nil)
        try XCTSkipUnless(CGImageDestinationFinalize(destination), "HEIC fixture encoding is unavailable on this device")
        let jpeg = try decodeJPEG(UploadImage.prepare(data: original as Data))
        XCTAssertEqual(jpeg.width, 96)
        XCTAssertEqual(jpeg.height, 64)
        try assertPixel(jpeg, x: 24, y: 16, is: .red)
    }

    func testSourceGPSExifAndCameraModelAreRemoved() throws {
        let date = "2024:07:21 12:00:00"
        let model = "Private camera"
        let original = try encode([markedImage()], as: .jpeg, properties: [
            kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 12.5, kCGImagePropertyGPSLatitudeRef: "N"],
            kCGImagePropertyExifDictionary: [kCGImagePropertyExifDateTimeOriginal: date],
            kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFModel: model]
        ])
        let input = try properties(of: original)
        let gps = input[kCGImagePropertyGPSDictionary] as? [CFString: Any]
        let exif = input[kCGImagePropertyExifDictionary] as? [CFString: Any]
        let tiff = input[kCGImagePropertyTIFFDictionary] as? [CFString: Any]
        XCTAssertEqual(gps?[kCGImagePropertyGPSLatitude] as? Double, 12.5)
        XCTAssertEqual(exif?[kCGImagePropertyExifDateTimeOriginal] as? String, date)
        XCTAssertEqual(tiff?[kCGImagePropertyTIFFModel] as? String, model)
        let output = try properties(of: UploadImage.prepare(data: original))
        XCTAssertNil(output[kCGImagePropertyGPSDictionary])
        XCTAssertNil((output[kCGImagePropertyExifDictionary] as? [CFString: Any])?[kCGImagePropertyExifDateTimeOriginal])
        XCTAssertNil((output[kCGImagePropertyTIFFDictionary] as? [CFString: Any])?[kCGImagePropertyTIFFModel])
    }

    func testMultiFrameAndCorruptImagesAreRejected() throws {
        let image = try markedImage()
        let animated = try encode([image, image], as: .gif)
        XCTAssertEqual(CGImageSourceGetCount(try source(for: animated)), 2)
        let pngHeader = try encode([image], as: .png).prefix(33)
        let jpeg = try makeMediaJPEG(width: 96, height: 64)
        for data in [animated, Data(pngHeader), Data(jpeg.prefix(jpeg.count / 2)), Data()] {
            XCTAssertThrowsError(try UploadImage.prepare(data: data), "input length \(data.count)") {
                XCTAssertEqual($0 as? UploadImage.Failure, .unsupportedImage)
            }
        }
    }

    func testJPEGAcceptsBytesAfterEndMarkerAndRejectsEndMarkerInsideCommentOfTruncatedScan() throws {
        let jpeg = try makeMediaJPEG(width: 96, height: 64)
        let withTrailer = jpeg + Data([0x12, 0x34, 0x56])
        let prepared = try decodeJPEG(UploadImage.prepare(data: withTrailer))
        XCTAssertEqual(prepared.width, 96)
        XCTAssertEqual(prepared.height, 64)

        // COM has a two-byte payload. Its contents cannot terminate the image's scan.
        let comment = Data([0xff, 0xfe, 0x00, 0x04, 0xff, 0xd9])
        var truncated = Data(jpeg.prefix(2))
        truncated.append(comment)
        truncated.append(jpeg[2..<(jpeg.count / 2)])
        XCTAssertThrowsError(try UploadImage.prepare(data: truncated)) {
            XCTAssertEqual($0 as? UploadImage.Failure, .unsupportedImage)
        }
    }

    func testSinglePagePDFIsRejected() throws {
        let data = NSMutableData()
        let consumer = try XCTUnwrap(CGDataConsumer(data: data))
        var page = CGRect(x: 0, y: 0, width: 96, height: 64)
        let pdf = try XCTUnwrap(CGContext(consumer: consumer, mediaBox: &page, nil))
        pdf.beginPDFPage(nil)
        pdf.fill(page)
        pdf.endPDFPage()
        pdf.closePDF()
        XCTAssertThrowsError(try UploadImage.prepare(data: data as Data)) {
            XCTAssertEqual($0 as? UploadImage.Failure, .unsupportedImage)
        }
    }

    func testRejectsOutOfRangeSettingsAndUsesRequestedQuality() throws {
        let original = try makeMediaJPEG(width: 128, height: 128)
        for (edge, quality) in [(0, 80), (4097, 80), (2048, 0), (2048, 101)] {
            XCTAssertThrowsError(try UploadImage.prepare(data: original, maxEdge: edge, quality: quality)) {
                XCTAssertEqual($0 as? UploadImage.Failure, .invalidParameters)
            }
        }
        let lowest = try UploadImage.prepare(data: original, quality: 1)
        let highest = try UploadImage.prepare(data: original, quality: 100)
        XCTAssertLessThan(lowest.count, highest.count)
    }

    func testCancellationBeforeOrDuringPreparationThrowsCancellationError() throws {
        let original = try makeMediaJPEG(width: 256, height: 64)
        XCTAssertThrowsError(try UploadImage.prepare(data: original, isCancelled: { true })) {
            XCTAssertTrue($0 is CancellationError)
        }
        var started = false
        XCTAssertThrowsError(try UploadImage.prepare(data: original, isCancelled: {
            defer { started = true }
            return started
        })) {
            XCTAssertTrue($0 is CancellationError)
        }
    }

    func testJPEGExceedingTwentyMiBAtRequestedQualityIsRejected() throws {
        // Tiling a deterministic noise sample makes a camera-sized fixture without shipping a binary.
        let tile = try decodeJPEG(makeMediaJPEG(width: 64, height: 64))
        let original: Data = try autoreleasepool {
            let context = try bitmap(width: 4096, height: 4096)
            context.draw(tile, in: CGRect(x: 0, y: 0, width: 64, height: 64), byTiling: true)
            return try encode([XCTUnwrap(context.makeImage())], as: .jpeg,
                              properties: [kCGImageDestinationLossyCompressionQuality: 0.65])
        }
        XCTAssertLessThan(original.count, 20 * 1024 * 1024)
        try autoreleasepool {
            let withinBudget = try UploadImage.prepare(data: original, maxEdge: 4096, quality: 35)
            XCTAssertLessThanOrEqual(withinBudget.count, 20 * 1024 * 1024)
            XCTAssertEqual(try decodeJPEG(withinBudget).width, 4096)
        }
        XCTAssertThrowsError(try UploadImage.prepare(data: original, maxEdge: 4096, quality: 100)) {
            XCTAssertEqual($0 as? UploadImage.Failure, .tooLarge)
        }
    }
}

private func source(for data: Data) throws -> CGImageSource {
    try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
}

private func properties(of data: Data) throws -> [CFString: Any] {
    try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source(for: data), 0, nil) as? [CFString: Any])
}

private func decodeJPEG(_ data: Data) throws -> CGImage {
    let source = try source(for: data)
    XCTAssertEqual(CGImageSourceGetType(source) as String?, UTType.jpeg.identifier)
    return try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
}

private func encode(_ images: [CGImage], as type: UTType, properties: [CFString: Any] = [:]) throws -> Data {
    let data = NSMutableData()
    let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, type.identifier as CFString, images.count, nil))
    for image in images {
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
    }
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    return data as Data
}

private func bitmap(width: Int, height: Int) throws -> CGContext {
    let sRGB = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
    let info = CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue
    return try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                   bytesPerRow: width * 4, space: sRGB, bitmapInfo: info))
}

private enum Color {
    case red, green, blue, yellow, white

    var rgb: [UInt8] {
        switch self {
        case .red: return [255, 0, 0]
        case .green: return [0, 255, 0]
        case .blue: return [0, 0, 255]
        case .yellow: return [255, 255, 0]
        case .white: return [255, 255, 255]
        }
    }
}

private func markedImage() throws -> CGImage {
    let context = try bitmap(width: 96, height: 64)
    let corners: [(Int, Int, Color)] = [(0, 32, .red), (48, 32, .green), (0, 0, .blue), (48, 0, .yellow)]
    for (x, y, color) in corners {
        let rgb = color.rgb.map { CGFloat($0) / 255 }
        context.setFillColor(red: rgb[0], green: rgb[1], blue: rgb[2], alpha: 1)
        context.fill(CGRect(x: x, y: y, width: 48, height: 32))
    }
    return try XCTUnwrap(context.makeImage())
}

private func pixelRGB(_ image: CGImage, x: Int, y: Int) throws -> [Int] {
    let pixel = try XCTUnwrap(image.cropping(to: CGRect(x: x, y: y, width: 1, height: 1)))
    let context = try bitmap(width: 1, height: 1)
    context.draw(pixel, in: CGRect(x: 0, y: 0, width: 1, height: 1))
    let rgba = try XCTUnwrap(context.data).assumingMemoryBound(to: UInt8.self)
    return [Int(rgba[0]), Int(rgba[1]), Int(rgba[2])]
}

private func assertPixel(_ image: CGImage, x: Int, y: Int, is expected: Color, message: String = "",
                         file: StaticString = #filePath, line: UInt = #line) throws {
    let actual = try pixelRGB(image, x: x, y: y)
    for (channel, value) in expected.rgb.enumerated() {
        XCTAssertEqual(actual[channel], Int(value), accuracy: 16, message, file: file, line: line)
    }
}

// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "OpenJSBridge",
    platforms: [.iOS(.v14), .macOS(.v11)],
    products: [.library(name: "NativeIOSHost", targets: ["NativeIOSHost"])],
    targets: [
        .target(name: "NativeIOSHost", path: "examples/native-ios/Sources/NativeIOSHost"),
        .testTarget(
            name: "NativeIOSHostTests",
            dependencies: ["NativeIOSHost"],
            path: "examples/native-ios/Tests/NativeIOSHostTests"
        )
    ]
)

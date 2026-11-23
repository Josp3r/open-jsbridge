// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "NativeIOSHost",
    platforms: [.iOS(.v14), .macOS(.v11)],
    products: [.library(name: "NativeIOSHost", targets: ["NativeIOSHost"])],
    targets: [
        .target(name: "NativeIOSHost"),
        .testTarget(name: "NativeIOSHostTests", dependencies: ["NativeIOSHost"])
    ]
)

import Foundation

enum DeviceModule {
    static let method = "device.getInfo"

    static func information() -> [String: String] {
        let version = ProcessInfo.processInfo.operatingSystemVersion
        return ["os": "ios", "osVersion": "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"]
    }
}

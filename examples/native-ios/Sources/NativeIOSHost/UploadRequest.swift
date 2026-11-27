import CoreFoundation
import Foundation

public extension NativeIOSHost {
    /// Grants one trusted page origin permission to upload to one exact HTTPS URL.
    /// Only configure endpoints whose response bodies can be shared with that page.
    struct UploadEndpoint {
        let origin: String
        let url: URL
        fileprivate let fileFields: Set<String>
        fileprivate let formFields: Set<String>
        fileprivate let headerNames: Set<String>
        fileprivate let hostHeaders: [String: String]
        fileprivate let confirm: (@MainActor (String) async -> Bool)?

        /// Page headers are opt-in and case insensitive. Host headers belong only to this endpoint.
        public init(origin: URL, url: URL, fileFields: Set<String> = ["file"], formFields: Set<String> = [],
                    headerNames: Set<String> = [], hostHeaders: [String: String] = [:],
                    confirm: (@MainActor (_ mediaID: String) async -> Bool)? = nil) throws {
            let allowedHeaders = Set(headerNames.map { $0.lowercased() })
            let nativeHeaders = Set(hostHeaders.keys.map { $0.lowercased() })
            guard let caller = AllowedOrigin(origin), UploadRequest.validEndpoint(url),
                  !fileFields.isEmpty, fileFields.allSatisfy(UploadRequest.validFieldName),
                  formFields.allSatisfy(UploadRequest.validFieldName),
                  headerNames.allSatisfy(UploadRequest.validHeaderName),
                  nativeHeaders.count == hostHeaders.count, allowedHeaders.isDisjoint(with: nativeHeaders),
                  !allowedHeaders.contains(where: UploadRequest.reservedPageHeader),
                  hostHeaders.allSatisfy({ UploadRequest.validHeaderName($0.key) && UploadRequest.validHeaderValue($0.value) }),
                  !nativeHeaders.contains(where: UploadRequest.transportHeader)
            else { throw UploadFailure(-32602, "invalid_endpoint_configuration") }
            self.origin = caller.serialized
            self.url = url
            self.fileFields = fileFields
            self.formFields = formFields
            self.headerNames = allowedHeaders
            self.hostHeaders = hostHeaders
            self.confirm = confirm
        }
    }
}

struct UploadFailure: Error, Equatable {
    let code: Int
    let reason: String

    init(_ code: Int, _ reason: String) {
        self.code = code
        self.reason = reason
    }
}

struct UploadRequest {
    static let method = "transfer.upload"

    let id: String
    let url: URL
    let fieldName: String
    let formData: [String: String]
    let headers: [String: String]
    let maxEdge: Int
    let quality: Int
    var confirm: (@MainActor (String) async -> Bool)? = nil

    private static let invalid = UploadFailure(-32602, "invalid_params")
    private static let tooLarge = UploadFailure(-32006, "metadata_too_large")

    /// The caller supplies only endpoints granted to the verified document origin.
    static func parse(_ params: [String: Any], endpoints: [NativeIOSHost.UploadEndpoint]) throws -> UploadRequest {
        guard params.count == 2, let id = params["id"] as? String,
              id.range(of: #"\A[0-9a-f]{32}\z"#, options: .regularExpression) != nil,
              let request = params["request"] as? [String: Any],
              Set(request.keys).isSubset(of: ["url", "method", "fieldName", "formData", "headers", "compress"]),
              let rawURL = request["url"] as? String, rawURL.hasPrefix("https://"),
              rawURL.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
              let parsedURL = URL(string: rawURL), validEndpoint(parsedURL),
              request["method"] == nil || request["method"] as? String == "POST",
              let fieldName = (request["fieldName"] ?? "file") as? String, validFieldName(fieldName),
              let compress = (request["compress"] ?? [:]) as? [String: Any],
              Set(compress.keys).isSubset(of: ["maxEdge", "quality"])
        else { throw invalid }
        let maxEdge = try integer(compress["maxEdge"] ?? 2048, in: 1...4096)
        let quality = try integer(compress["quality"] ?? 80, in: 1...100)
        let formData = try stringMap(request["formData"])
        let headers = try stringMap(request["headers"])
        guard formData.keys.allSatisfy(validFieldName), formData[fieldName] == nil,
              headers.allSatisfy({ validHeaderName($0.key) && validHeaderValue($0.value) })
        else { throw invalid }
        let headerNames = Set(headers.keys.map { $0.lowercased() })
        guard headerNames.count == headers.count else { throw invalid }
        let bytes = [formData, headers].reduce(0) { sum, map in
            sum + map.reduce(0) { $0 + $1.key.utf8.count + $1.value.utf8.count }
        }
        guard bytes <= 16 * 1024 else { throw tooLarge }
        guard !headerNames.contains(where: reservedPageHeader) else { throw UploadFailure(-32003, "forbidden_header") }
        guard let endpoint = endpoints.first(where: { $0.url.absoluteString.utf8.elementsEqual(rawURL.utf8) })
        else { throw UploadFailure(-32003, "endpoint_not_allowed") }
        guard endpoint.fileFields.contains(fieldName), Set(formData.keys).isSubset(of: endpoint.formFields)
        else { throw UploadFailure(-32003, "field_not_allowed") }
        guard headerNames.isSubset(of: endpoint.headerNames) else { throw UploadFailure(-32003, "forbidden_header") }
        return UploadRequest(id: id, url: endpoint.url, fieldName: fieldName, formData: formData,
                             headers: headers.merging(endpoint.hostHeaders) { _, native in native },
                             maxEdge: maxEdge, quality: quality, confirm: endpoint.confirm)
    }

    private static func stringMap(_ value: Any?) throws -> [String: String] {
        guard let value else { return [:] }
        guard let fields = value as? [String: Any] else { throw invalid }
        guard fields.count <= 16 else { throw tooLarge }
        guard let strings = fields as? [String: String] else { throw invalid }
        return strings
    }

    private static func integer(_ value: Any, in range: ClosedRange<Int>) throws -> Int {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              let integer = Int(exactly: number.doubleValue), range.contains(integer)
        else { throw invalid }
        return integer
    }

    fileprivate static func validEndpoint(_ url: URL) -> Bool {
        guard url.baseURL == nil, url.absoluteString.hasPrefix("https://"),
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.query == nil, components.fragment == nil
        else { return false }
        // Verify the authority with the same HTTPS parser as the trusted page origin.
        components.percentEncodedPath = ""
        guard let authority = components.url else { return false }
        return AllowedOrigin(authority) != nil
    }

    fileprivate static func validFieldName(_ name: String) -> Bool {
        name.range(of: #"\A[A-Za-z0-9_-]{1,64}\z"#, options: .regularExpression) != nil
    }

    fileprivate static func validHeaderName(_ name: String) -> Bool {
        name.range(of: #"\A[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}\z"#, options: .regularExpression) != nil
    }

    fileprivate static func validHeaderValue(_ value: String) -> Bool {
        value.utf8.allSatisfy { $0 >= 0x20 && $0 != 0x7f }
    }

    fileprivate static func reservedPageHeader(_ lower: String) -> Bool {
        lower == "authorization" || lower == "cookie" || lower == "cookie2" || transportHeader(lower)
    }

    fileprivate static func transportHeader(_ lower: String) -> Bool {
        switch lower {
        case "host", "transfer-encoding", "connection", "te", "trailer", "upgrade", "keep-alive",
             "expect", "origin", "referer", "via", "forwarded", "accept-encoding", "x-original-url", "x-rewrite-url":
            return true
        default:
            return lower.hasPrefix("content-") || lower.hasPrefix("proxy-") || lower.hasPrefix("x-forwarded-")
        }
    }
}

import Foundation
import Network

enum NetworkConnection: String {
    case wifi, cellular, ethernet, other, none, unknown

    var payload: [String: String] { ["type": rawValue] }

    init(status: NWPath.Status, usesInterface: (NWInterface.InterfaceType) -> Bool) {
        switch status {
        case .unsatisfied, .requiresConnection: self = .none
        case .satisfied:
            let interfaces: [(NWInterface.InterfaceType, NetworkConnection)] = [
                (.wifi, .wifi), (.cellular, .cellular), (.wiredEthernet, .ethernet)
            ]
            let matches = interfaces.filter { usesInterface($0.0) }
            self = matches.count == 1 ? matches[0].1 : .other
        @unknown default: self = .unknown
        }
    }
}

/// Keeps the latest normalized path for the active document's snapshot and push routes.
@MainActor
final class NetworkModule {
    typealias Update = @MainActor (NetworkConnection) -> Void
    typealias Watch = @MainActor (@escaping Update) -> () -> Void

    nonisolated static let method = "network.getStatus"
    nonisolated static let event = "network.changed"

    private let watch: Watch
    private var generation: UUID?
    private var cancel: (() -> Void)?
    private(set) var type: NetworkConnection = .unknown

    init(watch: @escaping Watch) {
        self.watch = watch
    }

    deinit { cancel?() }

    func start(onChange: @escaping Update) {
        guard generation == nil else { return }
        let generation = UUID()
        self.generation = generation
        cancel = watch { [weak self] type in
            guard let self, self.generation == generation, self.type != type else { return }
            self.type = type
            onChange(type)
        }
    }

    func stop() {
        generation = nil
        type = .unknown
        cancel?()
        cancel = nil
    }

    static func watchSystemPath(_ update: @escaping Update) -> () -> Void {
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { path in
            let type = NetworkConnection(status: path.status, usesInterface: path.usesInterfaceType)
            DispatchQueue.main.async { update(type) }
        }
        monitor.start(queue: DispatchQueue(label: "dev.openjsbridge.network"))
        return { monitor.cancel() }
    }
}

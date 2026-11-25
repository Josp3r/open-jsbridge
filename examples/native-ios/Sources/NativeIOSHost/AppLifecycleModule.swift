import Foundation
#if os(iOS)
import UIKit
#endif

enum AppLifecycleEvent: String, CaseIterable {
    case foregrounded = "app.foregrounded"
    case backgrounded = "app.backgrounded"
}

/// Subscribes to UIKit's application-level transitions only while a document listens.
@MainActor
final class AppLifecycleModule: NSObject {
    private var onChange: ((AppLifecycleEvent) -> Void)?

    func start(_ onChange: @escaping (AppLifecycleEvent) -> Void) {
        #if os(iOS)
        guard self.onChange == nil else { return }
        self.onChange = onChange
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(foregrounded(_:)),
                           name: UIApplication.willEnterForegroundNotification, object: UIApplication.shared)
        center.addObserver(self, selector: #selector(backgrounded(_:)),
                           name: UIApplication.didEnterBackgroundNotification, object: UIApplication.shared)
        #endif
    }

    func stop() {
        guard onChange != nil else { return }
        NotificationCenter.default.removeObserver(self)
        onChange = nil
    }

    #if os(iOS)
    @objc private func foregrounded(_ notification: Notification) { onChange?(.foregrounded) }

    @objc private func backgrounded(_ notification: Notification) { onChange?(.backgrounded) }
    #endif
}

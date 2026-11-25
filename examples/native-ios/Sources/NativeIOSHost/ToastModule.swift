import WebKit

#if os(iOS)
import UIKit
#endif

@MainActor
final class ToastModule {
    nonisolated static let method = "ui.toast.show"

    #if os(iOS)
    private var overlay: UIView?
    private var dismissal: Task<Void, Never>?
    #endif

    func show(_ text: String, in webView: WKWebView) -> Bool {
        #if os(iOS)
        guard let window = webView.window, !window.isHidden, !webView.isHidden,
              !webView.bounds.isEmpty, window.windowScene?.activationState == .foregroundActive else { return false }
        dismiss()

        let label = UILabel()
        label.text = text
        label.font = .preferredFont(forTextStyle: .subheadline)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = .systemBackground
        label.textAlignment = .center
        label.numberOfLines = 4
        label.isAccessibilityElement = true

        let container = UIStackView(arrangedSubviews: [label])
        container.translatesAutoresizingMaskIntoConstraints = false
        container.isUserInteractionEnabled = false
        container.isLayoutMarginsRelativeArrangement = true
        container.layoutMargins = UIEdgeInsets(top: 10, left: 16, bottom: 10, right: 16)
        container.backgroundColor = .label
        container.layer.cornerRadius = 12
        webView.addSubview(container)
        let safeArea = webView.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            container.centerXAnchor.constraint(equalTo: safeArea.centerXAnchor),
            container.leadingAnchor.constraint(greaterThanOrEqualTo: safeArea.leadingAnchor, constant: 16),
            container.trailingAnchor.constraint(lessThanOrEqualTo: safeArea.trailingAnchor, constant: -16),
            container.widthAnchor.constraint(lessThanOrEqualToConstant: 360),
            container.bottomAnchor.constraint(equalTo: safeArea.bottomAnchor, constant: -20)
        ])
        webView.layoutIfNeeded()
        overlay = container
        UIAccessibility.post(notification: .announcement, argument: text)
        dismissal = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            guard !Task.isCancelled else { return }
            self?.dismiss()
        }
        return true
        #else
        return false
        #endif
    }

    func dismiss() {
        #if os(iOS)
        dismissal?.cancel()
        dismissal = nil
        overlay?.removeFromSuperview()
        overlay = nil
        #endif
    }
}

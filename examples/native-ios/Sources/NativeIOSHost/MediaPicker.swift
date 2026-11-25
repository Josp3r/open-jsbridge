#if os(iOS)
import PhotosUI
import UniformTypeIdentifiers
import WebKit

@MainActor
final class MediaPicker: NSObject, PHPickerViewControllerDelegate {
    private static let importQueue = DispatchQueue(label: "dev.openjsbridge.media")
    private var picker: PHPickerViewController?
    private var continuation: CheckedContinuation<MediaSelection, Error>?
    private var progress: Progress?
    private var importProgress: Progress?

    func choose(in webView: WKWebView) async throws -> MediaSelection {
        try Task.checkCancellation()
        guard continuation == nil else { throw MediaProfileError.busy }
        guard let window = webView.window, !window.isHidden,
              window.windowScene?.activationState == .foregroundActive,
              let presenter = window.rootViewController, presenter.viewIfLoaded?.window === window,
              presenter.presentedViewController == nil, presenter.transitionCoordinator == nil,
              !presenter.isBeingPresented, !presenter.isBeingDismissed else {
            throw MediaProfileError.unavailable
        }

        var configuration = PHPickerConfiguration()
        configuration.filter = .images
        configuration.selectionLimit = 1
        configuration.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = self
        picker.modalPresentationStyle = .fullScreen
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            self.picker = picker
            presenter.present(picker, animated: true)
        }
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        guard self.picker === picker, progress == nil else { return }
        picker.dismiss(animated: true)
        guard let result = results.first else {
            finish(.success(.cancelled))
            return
        }
        let provider = result.itemProvider
        guard results.count == 1,
              let type = provider.registeredTypeIdentifiers.compactMap({ UTType($0) }).first(where: {
                  $0.conforms(to: .image) && $0.preferredMIMEType?.hasPrefix("image/") == true
              }),
              let mime = type.preferredMIMEType else {
            finish(.failure(MediaProfileError.unavailable))
            return
        }
        let processing = Progress(totalUnitCount: 1)
        importProgress = processing
        progress = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { [weak self, weak picker] url, error in
            // Open while the provider still owns the URL. The open file remains readable
            // after the provider removes its temporary pathname on callback return.
            let file = Result {
                guard let url else { throw error ?? MediaProfileError.unavailable }
                return try FileHandle(forReadingFrom: url)
            }
            Self.importQueue.async {
                let result = file.flatMap { handle in
                    Result { try Self.readImage(handle, mime: mime, processing: processing) }
                }
                Task { @MainActor [weak self, weak picker] in
                    guard let self, let picker, self.picker === picker else { return }
                    self.finish(result)
                }
            }
        }
    }

    func cancel() {
        guard let picker else { return }
        picker.dismiss(animated: false)
        progress?.cancel()
        importProgress?.cancel()
        finish(.failure(CancellationError()))
    }

    private func finish(_ result: Result<MediaSelection, Error>) {
        let continuation = continuation
        self.continuation = nil
        picker = nil
        progress = nil
        importProgress = nil
        continuation?.resume(with: result)
    }

    private nonisolated static func readImage(_ handle: FileHandle, mime: String, processing: Progress) throws -> MediaSelection {
        defer { try? handle.close() }
        var data = Data()
        while !processing.isCancelled, let chunk = try handle.read(upToCount: 64 * 1024), !chunk.isEmpty {
            guard chunk.count <= MediaStore.maxBytes - data.count else { throw MediaProfileError.tooLarge }
            data.append(chunk)
        }
        return .selected(try MediaImage.prepare(data: data, mime: mime, isCancelled: { processing.isCancelled }))
    }
}
#else
import WebKit

@MainActor
final class MediaPicker {
    func choose(in webView: WKWebView) async throws -> MediaSelection {
        throw MediaProfileError.unavailable
    }

    func cancel() {}
}
#endif

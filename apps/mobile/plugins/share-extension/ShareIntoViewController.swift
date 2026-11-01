// Necode's copy of expo-sharing's share extension (plugins/withShareExtensionDisplayName.cjs puts
// it in place of the template). When the person has pinned threads, it shows a full sheet: the
// shared screenshots, the pinned threads to pick from (preselected when they tapped one in the
// share sheet's suggestion row) and their message. The app then sends it all to that thread.
// Without pinned threads it hands everything to the app at once, as the template does.
import AVFoundation
import Intents
import MobileCoreServices
import SwiftUI
import UIKit
import UniformTypeIdentifiers

class ShareIntoViewController: UIViewController {
  private var hostAppScheme: String {
    guard let _hostAppScheme = Bundle.main.object(forInfoDictionaryKey: "MainTargetUrlScheme") as? String else {
      fatalError("Expo-sharing has failed to load the app scheme from `Info.plist`. Make sure the `expo-sharing` config plugin is configured correctly.")
    }
    return _hostAppScheme
  }

  private var appGroupId: String {
    guard let _appGroupId = Bundle.main.object(forInfoDictionaryKey: "AppGroupId") as? String else {
      fatalError("Expo-sharing has failed to load the app group ID from `Info.plist`. Make sure the `expo-sharing` config plugin is configured correctly.")
    }
    return _appGroupId
  }

  // MARK: - Necode: pinned threads

  struct PinnedThread: Codable, Identifiable {
    let id: String
    let title: String
    let subtitle: String
  }

  private struct ShareTarget: Codable {
    let id: String
    let comment: String
    let createdAt: Double
  }

  private lazy var pinnedThreads: [PinnedThread] = {
    guard let json = UserDefaults(suiteName: appGroupId)?.string(forKey: "necode.pinnedThreads"),
          let data = json.data(using: .utf8) else { return [] }
    return (try? JSONDecoder().decode([PinnedThread].self, from: data)) ?? []
  }()

  /// nil sends to a new task, as before pinned threads existed.
  private var selectedThread: PinnedThread?
  private var comment = ""
  private var composeMode: Bool { !pinnedThreads.isEmpty }
  private var handedOff = false

  // MARK: - Lifecycle

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemGroupedBackground
    guard composeMode else { return }
    let suggested = (extensionContext?.intent as? INSendMessageIntent)?.conversationIdentifier
    let model = ShareComposeModel(
      threads: pinnedThreads,
      selectedId: pinnedThreads.first { $0.id == suggested }?.id
    )
    model.onCancel = { [weak self] in
      self?.extensionContext?.cancelRequest(
        withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError)
      )
    }
    model.onSend = { [weak self, weak model] in
      guard let self, let model, !self.handedOff else { return }
      self.handedOff = true
      model.sending = true
      self.selectedThread = self.pinnedThreads.first { $0.id == model.selectedId }
      self.comment = model.message
      self.handleShare()
    }
    let host = UIHostingController(rootView: ShareComposeView(model: model))
    addChild(host)
    host.view.frame = view.bounds
    host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(host.view)
    host.didMove(toParent: self)
    loadPreviews(into: model)
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    if !composeMode && !handedOff {
      handedOff = true
      handleShare()
    }
  }

  private func loadPreviews(into model: ShareComposeModel) {
    let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
      .flatMap { $0.attachments ?? [] }
      .filter { $0.canLoadObject(ofClass: UIImage.self) }
      .prefix(6)
    for provider in providers {
      provider.loadObject(ofClass: UIImage.self) { image, _ in
        guard let image = image as? UIImage else { return }
        DispatchQueue.main.async { model.previews.append(image) }
      }
    }
  }

  private func saveShareTarget() {
    guard composeMode, let defaults = UserDefaults(suiteName: appGroupId) else { return }
    let comment = self.comment.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let thread = selectedThread else {
      defaults.removeObject(forKey: "necode.shareTarget")
      return
    }
    let target = ShareTarget(id: thread.id, comment: comment, createdAt: Date().timeIntervalSince1970 * 1000)
    if let data = try? JSONEncoder().encode(target), let json = String(data: data, encoding: .utf8) {
      defaults.set(json, forKey: "necode.shareTarget")
    }
  }

  // MARK: - Core Logic

  private func handleShare() {
    guard let items = extensionContext?.inputItems as? [NSExtensionItem] else {
      self.extensionContext?.completeRequest(returningItems: nil)
      return
    }

    Task {
      var payload = await Task.detached(priority: .userInitiated) {
        return await self.processInputItems(items)
      }.value

      // A comment for a new task travels as shared text; for a thread, with the target.
      let comment = self.comment.trimmingCharacters(in: .whitespacesAndNewlines)
      if self.composeMode && self.selectedThread == nil && !comment.isEmpty {
        payload.append(SharePayload(type: .text, value: comment, mimeType: "text/plain", metadata: nil))
      }
      if !payload.isEmpty {
        saveShareTarget()
        saveToUserDefaults(payload)
        openParentApp()
      } else {
        self.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
      }
    }
  }

  nonisolated private func processInputItems(_ items: [NSExtensionItem]) async -> [SharePayload] {
    var results: [SharePayload] = []

    for item in items {
      guard let attachments = item.attachments else { continue }

      for provider in attachments {
        if let payload = await parseProvider(provider) {
          results.append(payload)
        }
      }
    }

    return results
  }

  private func saveToUserDefaults(_ payload: [SharePayload]) {
    guard let userDefaults = UserDefaults(suiteName: appGroupId) else {
      print("Error: Expo-sharing could not initialize UserDefaults with group: \(appGroupId)")
      return
    }

    if let encoded = try? JSONEncoder().encode(payload) {
      userDefaults.set(encoded, forKey: SHARE_INTO_DEFAULTS_KEY)
      userDefaults.synchronize()
    } else {
      print("Error: Expo-sharing has failed to serialize shared data to JSON")
    }
  }

  // MARK: - Provider Parsing

  private func parseProvider(_ provider: NSItemProvider) async -> SharePayload? {
    if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) &&
    !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
      return await handleWebURL(provider)
    }

    if provider.hasItemConformingToTypeIdentifier(UTType.audio.identifier) {
      return await handleFile(provider, type: .audio, utType: .audio)
    }

    if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
      return await handleFile(provider, type: .video, utType: .movie)
    }

    if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
      return await handleFile(provider, type: .image, utType: .image)
    }

    if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) ||
    provider.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) {
      return await handleFile(provider, type: .file, utType: .data)
    }

    if provider.hasItemConformingToTypeIdentifier(UTType.text.identifier) {
      return await handleText(provider)
    }

    return nil
  }

  // MARK: - Handlers

  private func handleText(_ provider: NSItemProvider) async -> SharePayload? {
    return await withCheckedContinuation { continuation in
      provider.loadItem(forTypeIdentifier: UTType.text.identifier, options: nil) { item, _ in
        guard let text = item as? String else {
          continuation.resume(returning: nil)
          return
        }

        let payload = SharePayload(
          type: .text,
          value: text,
          mimeType: "text/plain",
          metadata: nil
        )
        continuation.resume(returning: payload)
      }
    }
  }

  private func handleWebURL(_ provider: NSItemProvider) async -> SharePayload? {
    return await withCheckedContinuation { continuation in
      provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, _ in
        guard let url = item as? URL else {
          continuation.resume(returning: nil)
          return
        }

        let payload = SharePayload(
          type: .url,
          value: url.absoluteString,
          mimeType: "text/html",
          metadata: nil
        )
        continuation.resume(returning: payload)
      }
    }
  }

  private func handleFile(_ provider: NSItemProvider, type: ShareType, utType: UTType) async -> SharePayload? {
    return await withCheckedContinuation { continuation in
      let identifier = provider.registeredTypeIdentifiers.first { providerIdentifier in
        UTType(providerIdentifier)?.conforms(to: utType) ?? false
      } ?? utType.identifier

      provider.loadItem(forTypeIdentifier: identifier, options: nil) { item, _ in
        if let url = item as? URL {
          let result = self.copyAndProcessFile(url: url, type: type)
          continuation.resume(returning: result)
          return
        }

        if let data = item as? Data {
          let fileName = UUID().randomFilename(forTypeIdentifier: identifier)
          let result = self.saveDataToAppGroup(
            data: data,
            fileName: fileName,
            type: type,
            mimeType: UTType(identifier)?.preferredMIMEType
          )
          continuation.resume(returning: result)
          return
        }

        if type == .image, let image = item as? UIImage, let data = image.pngData() {
          let fileName = UUID().uuidString + ".png"
          let result = self.saveDataToAppGroup(data: data, fileName: fileName, type: .image, mimeType: "image/png")
          continuation.resume(returning: result)
          return
        }

        continuation.resume(returning: nil)
      }
    }
  }

  // MARK: - File Management

  private func copyAndProcessFile(url: URL, type: ShareType) -> SharePayload? {
    guard let containerURL = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
      return nil
    }

    let fileName = url.lastPathComponent.isEmpty ? UUID().uuidString : url.lastPathComponent
    let destinationURL = containerURL.appendingPathComponent(fileName)

    do {
      if FileManager.default.fileExists(atPath: destinationURL.path) {
        try FileManager.default.removeItem(at: destinationURL)
      }
      try FileManager.default.copyItem(at: url, to: destinationURL)
    } catch {
      print("Error copying file: \(error)")
      return nil
    }

    let size = try? FileManager.default.attributesOfItem(atPath: destinationURL.path)[.size] as? Int
    let fileExt = destinationURL.pathExtension
    let mimeType = UTType(filenameExtension: fileExt)?.preferredMIMEType ?? "application/octet-stream"

    let metadata = ShareMetadata(
      originalName: fileName,
      size: size
    )

    return SharePayload(
      type: type,
      value: destinationURL.absoluteString,
      mimeType: mimeType,
      metadata: metadata
    )
  }

  private func saveDataToAppGroup(data: Data, fileName: String, type: ShareType, mimeType: String?) -> SharePayload? {
    guard let containerURL = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
      return nil
    }
    let destinationURL = containerURL.appendingPathComponent(fileName)

    do {
      try data.write(to: destinationURL)
    } catch {
      return nil
    }

    return SharePayload(
      type: type,
      value: destinationURL.absoluteString,
      mimeType: mimeType ?? "application/octet-stream",
      metadata: ShareMetadata(originalName: fileName, size: data.count)
    )
  }

  // MARK: - Open main app

  @MainActor
  func openParentApp() {
    guard let url = URL(string: "\(hostAppScheme)://expo-sharing") else {
      fatalError("The app scheme \(hostAppScheme) is invalid - it is not possible to create a valid deep link URL with it")
    }

    openURL(url)
    self.close()
  }

  // This is a hack that allows us to open the main app target from a share-extension target. Technically this is really
  // discouraged by apple, but I've found that multiple apps exist that use this method and pass the App Store review.
  // We should mention this as a possible future issue in the docs.
  private func openURL(_ url: URL) {
    var responder: UIResponder? = self
    while responder != nil {
      if let application = responder as? UIApplication {
        application.open(url, options: [:], completionHandler: nil)
      }
      responder = responder?.next
    }
  }

  private func close() {
    self.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
  }
}

private extension UUID {
  func randomFilename(forTypeIdentifier identifier: String) -> String {
    var ext = ""
    if let preferredExtension = UTType(identifier)?.preferredFilenameExtension {
      ext = ".\(preferredExtension)"
    }
    return UUID().uuidString + ext
  }
}

// MARK: - Necode compose sheet

private let newTaskId = "necode.newTask"

final class ShareComposeModel: ObservableObject {
  let threads: [ShareIntoViewController.PinnedThread]
  @Published var selectedId: String?
  @Published var message = ""
  @Published var previews: [UIImage] = []
  @Published var sending = false
  var onSend: () -> Void = {}
  var onCancel: () -> Void = {}

  init(threads: [ShareIntoViewController.PinnedThread], selectedId: String?) {
    self.threads = threads
    self.selectedId = selectedId
  }
}

struct ShareComposeView: View {
  @ObservedObject var model: ShareComposeModel

  var body: some View {
    NavigationStack {
      List {
        if !model.previews.isEmpty {
          Section {
            ScrollView(.horizontal, showsIndicators: false) {
              HStack(spacing: 10) {
                ForEach(Array(model.previews.enumerated()), id: \.offset) { _, image in
                  Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 96, height: 170)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
              }
              .padding(.vertical, 4)
            }
          }
          .listRowBackground(Color.clear)
          .listRowInsets(EdgeInsets())
        }

        Section("Hilo") {
          ForEach(model.threads) { thread in
            row(id: thread.id, title: thread.title, subtitle: thread.subtitle)
          }
          row(id: newTaskId, title: "Nueva tarea", subtitle: "Elegir proyecto en Necode")
        }

        Section("Mensaje") {
          TextField("Escribe qué quieres decirle…", text: $model.message, axis: .vertical)
            .lineLimit(3...10)
        }
      }
      .listStyle(.insetGrouped)
      .navigationTitle("Enviar a Necode")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancelar") { model.onCancel() }
        }
        ToolbarItem(placement: .confirmationAction) {
          if model.sending {
            ProgressView()
          } else {
            Button("Enviar") { model.onSend() }
              .bold()
              .disabled(model.selectedId == nil)
          }
        }
      }
    }
  }

  private func row(id: String, title: String, subtitle: String) -> some View {
    Button {
      model.selectedId = id
    } label: {
      HStack {
        VStack(alignment: .leading, spacing: 2) {
          Text(title).foregroundStyle(.primary).lineLimit(1)
          Text(subtitle).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
        }
        Spacer()
        if model.selectedId == id {
          Image(systemName: "checkmark.circle.fill").foregroundStyle(.tint)
        } else {
          Image(systemName: "circle").foregroundStyle(.tertiary)
        }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

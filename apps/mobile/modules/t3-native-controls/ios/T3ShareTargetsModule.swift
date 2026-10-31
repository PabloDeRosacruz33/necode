import ExpoModulesCore
import Intents
import UIKit

/// Necode: pinned threads as targets in the iOS share sheet. The app writes them to the share
/// extension's App Group and donates each as a conversation (`INSendMessageIntent`), which is how
/// iOS puts them in the share sheet's suggestion row. The extension writes back the thread the
/// person picked, and the app sends the shared items there (see `takeShareTarget`).
public final class T3ShareTargetsModule: Module {
  static let pinnedThreadsKey = "necode.pinnedThreads"
  static let shareTargetKey = "necode.shareTarget"
  static let donationGroup = "necode.pinnedThreads"

  struct PinnedThread: Codable {
    let id: String
    let title: String
    let subtitle: String
  }

  public func definition() -> ModuleDefinition {
    Name("T3ShareTargets")

    AsyncFunction("setPinnedThreads") { (appGroupId: String, json: String) in
      guard let defaults = UserDefaults(suiteName: appGroupId),
            let data = json.data(using: .utf8),
            let threads = try? JSONDecoder().decode([PinnedThread].self, from: data) else {
        return
      }
      defaults.set(json, forKey: Self.pinnedThreadsKey)
      INInteraction.delete(with: Self.donationGroup) { _ in
        for thread in threads {
          Self.donate(thread)
        }
      }
    }

    // The thread picked in the share extension, as JSON, removed so it is used once.
    Function("takeShareTarget") { (appGroupId: String) -> String? in
      guard let defaults = UserDefaults(suiteName: appGroupId),
            let target = defaults.string(forKey: Self.shareTargetKey) else {
        return nil
      }
      defaults.removeObject(forKey: Self.shareTargetKey)
      return target
    }
  }

  private static func donate(_ thread: PinnedThread) {
    let name = INSpeakableString(spokenPhrase: thread.title)
    let intent = INSendMessageIntent(
      recipients: nil,
      outgoingMessageType: .outgoingMessageText,
      content: nil,
      speakableGroupName: name,
      conversationIdentifier: thread.id,
      serviceName: nil,
      sender: nil,
      attachments: nil
    )
    if let image = monogram(for: thread.title).pngData() {
      intent.setImage(INImage(imageData: image), forParameterNamed: \.speakableGroupName)
    }
    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .outgoing
    interaction.groupIdentifier = donationGroup
    interaction.donate { _ in }
  }

  /// A round badge with the thread's first letter, so pinned threads tell apart in the share sheet.
  private static func monogram(for title: String) -> UIImage {
    let size = CGSize(width: 120, height: 120)
    let letter = title.trimmingCharacters(in: .whitespacesAndNewlines).first.map { String($0).uppercased() } ?? "N"
    let hues: [CGFloat] = [0.58, 0.75, 0.95, 0.08, 0.33, 0.5]
    // A stable hash: Swift's hashValue changes from launch to launch.
    let hue = hues[title.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF } % hues.count]
    return UIGraphicsImageRenderer(size: size).image { _ in
      UIColor(hue: hue, saturation: 0.55, brightness: 0.85, alpha: 1).setFill()
      UIBezierPath(ovalIn: CGRect(origin: .zero, size: size)).fill()
      let attributes: [NSAttributedString.Key: Any] = [
        .font: UIFont.systemFont(ofSize: 56, weight: .semibold),
        .foregroundColor: UIColor.white,
      ]
      let text = letter as NSString
      let textSize = text.size(withAttributes: attributes)
      text.draw(
        at: CGPoint(x: (size.width - textSize.width) / 2, y: (size.height - textSize.height) / 2),
        withAttributes: attributes
      )
    }
  }
}

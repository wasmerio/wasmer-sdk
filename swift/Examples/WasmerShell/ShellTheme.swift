import SwiftUI
import UIKit

/// Matches wasmer-sh/src/styles.css and the terminal theme in src/main.ts.
@MainActor
enum ShellTheme {
  static let page = Color(uiColor: uiColor(0x09090d))
  static let panel = Color(uiColor: terminalBackground)
  static let text = Color(uiColor: uiColor(0xf4f2f8))
  static let muted = Color(uiColor: uiColor(0x8f8b9d))
  static let terminalBackground = uiColor(0x0c0c12)
  static let cursor = uiColor(0xa78bfa)

  private static func uiColor(_ rgb: UInt32) -> UIColor {
    UIColor(red: CGFloat((rgb >> 16) & 255) / 255,
      green: CGFloat((rgb >> 8) & 255) / 255, blue: CGFloat(rgb & 255) / 255, alpha: 1)
  }
}

struct ShellButtonStyle: ButtonStyle {
  var isSelected = false
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .padding(.horizontal, 10)
      .frame(minWidth: 44, minHeight: 44)
      .foregroundStyle(isSelected || configuration.isPressed ? ShellTheme.text : ShellTheme.muted)
      .background(.white.opacity(configuration.isPressed ? 0.10 : isSelected ? 0.06 : 0),
        in: RoundedRectangle(cornerRadius: 7))
      .contentShape(RoundedRectangle(cornerRadius: 7))
      .opacity(isEnabled ? 1 : 0.42)
  }
}

import UIKit
import SwiftUI

/// Native UIKit renderer/input surface. All VT state belongs to libghostty-vt;
/// the Wasm execution WebView is separate and never presented.
@MainActor
final class TerminalView: UIView, UIKeyInput {
  private let terminal: OpaquePointer
  private let font = UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)
  private let boldFont = UIFont.monospacedSystemFont(ofSize: 13, weight: .bold)
  private let cellWidth: CGFloat
  private let cellHeight: CGFloat = 19
  private let inset: CGFloat = 12
  private(set) var columns = 80
  private(set) var rows = 24
  var onInput: ((Data) -> Void)?
  var onResize: ((Int, Int) -> Void)?
  var autocorrectionType: UITextAutocorrectionType = .no
  var autocapitalizationType: UITextAutocapitalizationType = .none
  var spellCheckingType: UITextSpellCheckingType = .no
  var smartQuotesType: UITextSmartQuotesType = .no
  var smartDashesType: UITextSmartDashesType = .no
  var smartInsertDeleteType: UITextSmartInsertDeleteType = .no
  var keyboardAppearance: UIKeyboardAppearance = .dark
  var keyboardType: UIKeyboardType = .asciiCapable
  var hasText: Bool { true }
  override var canBecomeFirstResponder: Bool { true }

  override init(frame: CGRect) {
    guard let terminal = wt_new(80, 24) else { fatalError("Unable to initialize libghostty-vt") }
    self.terminal = terminal
    cellWidth = ("M" as NSString).size(withAttributes: [.font: UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)]).width
    super.init(frame: frame)
    backgroundColor = ShellTheme.terminalBackground
    isOpaque = true
    contentMode = .redraw
    accessibilityLabel = "Terminal"
    accessibilityIdentifier = "wasmer-terminal"
    addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(focus)))
    addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(scroll(_:))))
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) is unsupported") }
  isolated deinit { wt_free(terminal) }

  @objc func focus() { becomeFirstResponder() }
  @objc private func scroll(_ gesture: UIPanGestureRecognizer) {
    let delta = Int(gesture.translation(in: self).y / cellHeight)
    if delta != 0 {
      wt_scroll(terminal, Int32(-delta))
      gesture.setTranslation(.zero, in: self)
      setNeedsDisplay()
    }
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    let newColumns = max(10, min(500, Int((bounds.width - 2 * inset) / cellWidth)))
    let newRows = max(3, min(200, Int((bounds.height - 2 * inset) / cellHeight)))
    guard newColumns != columns || newRows != rows else { return }
    guard wt_resize(terminal, UInt16(newColumns), UInt16(newRows)) else { return }
    columns = newColumns; rows = newRows
    onResize?(columns, rows)
    setNeedsDisplay()
  }

  func feed(_ bytes: Data) {
    bytes.withUnsafeBytes { buffer in
      wt_feed(terminal, buffer.bindMemory(to: UInt8.self).baseAddress, buffer.count)
    }
    // Process terminal query replies after vt_write returns (no reentrancy).
    var reply = [UInt8](repeating: 0, count: 65536)
    let count = wt_take_response(terminal, &reply, reply.count)
    if count > 0 { onInput?(Data(reply.prefix(count))) }
    setNeedsDisplay()
  }
  func insertText(_ text: String) {
    wt_bottom(terminal)
    onInput?(Data(text.replacingOccurrences(of: "\n", with: "\r").utf8))
    setNeedsDisplay()
  }
  func deleteBackward() { sendKey(4) }
  func sendKey(_ key: Int32) {
    wt_bottom(terminal)
    var bytes = [UInt8](repeating: 0, count: 128)
    let count = wt_key(terminal, key, &bytes, bytes.count)
    if count > 0 { onInput?(Data(bytes.prefix(count))) }
  }
  func sendControl(_ value: UInt8) { onInput?(Data([value])) }

  override var keyCommands: [UIKeyCommand]? {
    let commands = [
      UIKeyCommand(input: UIKeyCommand.inputUpArrow, modifierFlags: [], action: #selector(key(_:))),
      UIKeyCommand(input: UIKeyCommand.inputDownArrow, modifierFlags: [], action: #selector(key(_:))),
      UIKeyCommand(input: UIKeyCommand.inputLeftArrow, modifierFlags: [], action: #selector(key(_:))),
      UIKeyCommand(input: UIKeyCommand.inputRightArrow, modifierFlags: [], action: #selector(key(_:))),
      UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(key(_:))),
      UIKeyCommand(input: "\t", modifierFlags: [], action: #selector(key(_:))),
    ] + ["a", "c", "d", "e", "l"].map { UIKeyCommand(input: $0, modifierFlags: .control, action: #selector(key(_:))) }
    commands.forEach { $0.wantsPriorityOverSystemBehavior = true }
    return commands
  }
  @objc private func key(_ command: UIKeyCommand) {
    if command.modifierFlags.contains(.control), let byte = command.input?.utf8.first {
      sendControl(byte & 0x1f); return
    }
    let keys = [UIKeyCommand.inputUpArrow: 0, UIKeyCommand.inputDownArrow: 1,
      UIKeyCommand.inputLeftArrow: 2, UIKeyCommand.inputRightArrow: 3,
      "\t": 6, UIKeyCommand.inputEscape: 7]
    if let key = keys[command.input ?? ""] { sendKey(Int32(key)) }
  }

  private func color(_ rgb: UInt32) -> UIColor {
    UIColor(red: CGFloat((rgb >> 16) & 255) / 255, green: CGFloat((rgb >> 8) & 255) / 255,
      blue: CGFloat(rgb & 255) / 255, alpha: 1)
  }
  override func draw(_ rect: CGRect) {
    guard let context = UIGraphicsGetCurrentContext() else { return }
    var frame = WTFrame()
    guard wt_begin_frame(terminal, &frame) else { return }
    color(frame.background).setFill(); context.fill(bounds)
    var cell = WTCell()
    while wt_next_cell(terminal, &cell) {
      // A wide glyph already paints its trailing spacer cell.
      guard cell.width > 0 else { continue }
      let box = CGRect(x: inset + CGFloat(cell.column) * cellWidth, y: inset + CGFloat(cell.row) * cellHeight,
        width: cellWidth * CGFloat(max(1, cell.width)), height: cellHeight)
      color(cell.background).setFill(); context.fill(box)
      guard cell.width > 0, cell.length > 0, let bytes = cell.text else { continue }
      let text = String(decoding: UnsafeBufferPointer(start: bytes, count: cell.length), as: UTF8.self)
      var attributes: [NSAttributedString.Key: Any] = [.font: cell.bold ? boldFont : font, .foregroundColor: color(cell.foreground)]
      if cell.underline { attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue }
      if cell.strike { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
      if cell.italic { attributes[.obliqueness] = 0.15 }
      context.saveGState(); context.clip(to: box)
      (text as NSString).draw(at: CGPoint(x: box.minX, y: box.minY + 1), withAttributes: attributes)
      context.restoreGState()
    }
    if frame.visible {
      ShellTheme.cursor.setFill()
      context.fill(CGRect(x: inset + CGFloat(frame.column) * cellWidth, y: inset + CGFloat(frame.row + 1) * cellHeight - 3,
        width: cellWidth, height: 2))
    }
  }

  /// Used by the integration probe to verify the actual VT state, not raw logs.
  var visibleText: String {
    var frame = WTFrame(); var cell = WTCell(); var value = ""; var row = 0
    guard wt_begin_frame(terminal, &frame) else { return "" }
    while wt_next_cell(terminal, &cell) {
      if Int(cell.row) != row { value += "\n"; row = Int(cell.row) }
      if cell.width == 0 { continue }
      if let bytes = cell.text, cell.length > 0 {
        value += String(decoding: UnsafeBufferPointer(start: bytes, count: cell.length), as: UTF8.self)
      } else { value += " " }
    }
    return value
  }
}

struct NativeTerminal: UIViewRepresentable {
  let view: TerminalView
  func makeUIView(context: Context) -> TerminalView { view }
  func updateUIView(_ uiView: TerminalView, context: Context) {}
}

import AppKit

@main
struct PrototypeMain {
  static func main() {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    Task { @MainActor in
      let report = await runPrototypeProbe { print($0) }
      let data = try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
      print(String(decoding: data, as: UTF8.self))
      exit(report["passed"] as? Bool == true ? 0 : 1)
    }
    app.run()
  }
}

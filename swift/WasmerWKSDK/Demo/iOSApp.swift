import SwiftUI

@main
struct PrototypeApp: App {
  @State private var status = "Starting hidden WebKit runtime…"
  var body: some Scene {
    WindowGroup {
      ScrollView { Text(status).font(.system(.body, design: .monospaced)).padding() }
        .task {
          let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
          let report = await runPrototypeProbe {
            status += "\n\($0)"
            try? Data(status.utf8).write(to: documents.appendingPathComponent("prototype-progress.txt"), options: .atomic)
          }
          let data = try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
          let url = documents.appendingPathComponent("prototype-result.json")
          try! data.write(to: url, options: .atomic)
          status += "\n" + String(decoding: data, as: UTF8.self)
          print(String(decoding: data, as: UTF8.self))
        }
    }
  }
}

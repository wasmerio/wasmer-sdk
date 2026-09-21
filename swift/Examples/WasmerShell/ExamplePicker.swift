import Foundation
import SwiftUI

/// The web shell and native shell use one catalog and the same source files.
struct ShellExample: Decodable, Identifiable, Sendable {
  let id: String
  let source: String
  let title: String
  let group: String
  let description: String
  let icon: String
  let color: String
  let dependencies: String
  let packages: [String]
  let install: String?
  let run: String

  static let all: [ShellExample] = {
    do {
      guard let url = Bundle.main.url(forResource: "examples", withExtension: "json") else {
        throw DemoError.failed("Missing example catalog")
      }
      return try JSONDecoder().decode([ShellExample].self, from: Data(contentsOf: url))
    } catch { preconditionFailure("Invalid bundled example catalog: \(error)") }
  }()

  var tint: Color {
    let rgb = UInt32(color, radix: 16) ?? 0xFFFFFF
    return Color(red: Double((rgb >> 16) & 255) / 255,
                 green: Double((rgb >> 8) & 255) / 255,
                 blue: Double(rgb & 255) / 255)
  }
}

struct ExamplePicker: View {
  @ObservedObject var session: TerminalSession

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 26) {
        VStack(alignment: .leading, spacing: 10) {
          Text("START SOMETHING NEW").font(.caption).tracking(1.5).foregroundStyle(.mint)
          Text("Choose an example").font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
          Text("A terminal, your code, and everything you need to get started.")
            .font(.subheadline).foregroundStyle(.secondary)
          if session.ready {
            Button("Resume terminal →") { session.showingExamples = false }
              .padding(.top, 6)
          }
        }
        ForEach(["Node.js", "Python", "Tools"], id: \.self) { group in
          VStack(alignment: .leading, spacing: 12) {
            Text(group.uppercased()).font(.caption.weight(.semibold)).tracking(1)
              .foregroundStyle(.secondary).accessibilityAddTraits(.isHeader)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 155), spacing: 12)], spacing: 12) {
              ForEach(ShellExample.all.filter { $0.group == group }) { example in
                Button { Task { await session.chooseExample(example) } } label: {
                  VStack(alignment: .leading, spacing: 10) {
                    Text(example.icon).font(.system(size: 25, weight: .semibold, design: .monospaced))
                      .foregroundStyle(example.tint).frame(width: 42, height: 42)
                      .background(example.tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 9))
                      .accessibilityHidden(true)
                    Text(example.title).font(.headline).foregroundStyle(.primary)
                    Text(example.description).font(.caption).foregroundStyle(.secondary)
                      .fixedSize(horizontal: false, vertical: true)
                    Text(example.dependencies).font(.caption2).foregroundStyle(.secondary)
                      .fixedSize(horizontal: false, vertical: true)
                  }
                  .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                  .padding(16)
                  .background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 12))
                  .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.white.opacity(0.09)))
                }.buttonStyle(.plain).accessibilityIdentifier("example-" + example.id)
              }
            }
          }
        }
        Divider()
        VStack(alignment: .leading, spacing: 12) {
          Text("Just need a terminal?").font(.headline)
          Text("Open Bash with Node.js, Python, and command-line tools.")
            .font(.subheadline).foregroundStyle(.secondary)
          Button("Open full shell →") { Task { await session.chooseExample(nil) } }
            .accessibilityIdentifier("example-shell")
          Text("Each example loads only its required runtimes. Install dependencies in the terminal when you’re ready.")
            .font(.caption).foregroundStyle(.secondary).padding(.top, 8)
        }
      }.padding(20).frame(maxWidth: 900)
        .frame(maxWidth: .infinity)
    }.disabled(session.starting)
  }
}

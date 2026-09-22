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
}

struct ExamplePicker: View {
  @ObservedObject var session: TerminalSession

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 26) {
        VStack(alignment: .leading, spacing: 10) {
          Text("Choose an example").font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
          Text("A terminal, your code, and everything you need to get started.")
            .font(.subheadline).foregroundStyle(ShellTheme.muted)
          if session.ready {
            Button("Resume terminal →") { session.showingExamples = false }
              .buttonStyle(ShellButtonStyle())
              .padding(.top, 6)
          }
        }
        ForEach(["Node.js", "Python", "Tools"], id: \.self) { group in
          VStack(alignment: .leading, spacing: 12) {
            Text(group.uppercased()).font(.caption.weight(.semibold)).tracking(1)
              .foregroundStyle(ShellTheme.muted).accessibilityAddTraits(.isHeader)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 155), spacing: 12)], spacing: 12) {
              ForEach(ShellExample.all.filter { $0.group == group }) { example in
                Button { Task { await session.chooseExample(example) } } label: {
                  VStack(alignment: .leading, spacing: 10) {
                    Image("example-" + example.id).resizable().renderingMode(.original).scaledToFit()
                      .frame(width: 42, height: 42)
                      .accessibilityHidden(true)
                    Text(example.title).font(.headline).foregroundStyle(ShellTheme.text)
                    Text(example.description).font(.caption).foregroundStyle(ShellTheme.muted)
                      .fixedSize(horizontal: false, vertical: true)
                    Text(example.dependencies).font(.caption2).foregroundStyle(ShellTheme.muted)
                      .fixedSize(horizontal: false, vertical: true)
                  }
                  .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                  .padding(16)
                  .background(ShellTheme.panel, in: RoundedRectangle(cornerRadius: 12))
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
            .font(.subheadline).foregroundStyle(ShellTheme.muted)
          Button("Open full shell →") { Task { await session.chooseExample(nil) } }
            .buttonStyle(ShellButtonStyle(isSelected: true))
            .accessibilityIdentifier("example-shell")
          Text("Each example loads only its required runtimes. Install dependencies in the terminal when you’re ready.")
            .font(.caption).foregroundStyle(ShellTheme.muted).padding(.top, 8)
        }
      }.padding(20).frame(maxWidth: 900)
        .frame(maxWidth: .infinity)
    }.disabled(session.starting)
  }
}

import SwiftUI
import WasmerSDK

struct ShellLoadingState {
  var sdkLoaded = false
  var packages: [LoadingPackage] = []
  var error: String?

  init(names: [String] = []) { packages = names.map { LoadingPackage(id: $0) } }

  mutating func update(_ progress: PackageLoadProgress) {
    // WebKit only forwards package events after runtime initialization succeeds.
    sdkLoaded = true
    for package in progress.packages {
      let index = index(for: package.id)
      packages[index].progress = package
    }
  }

  mutating func complete(_ ids: [String]) {
    sdkLoaded = true
    for id in ids { _ = index(for: id) }
    for index in packages.indices { packages[index].loaded = true }
  }

  private mutating func index(for id: String) -> Int {
    if let index = packages.firstIndex(where: { $0.id == id }) { return index }
    if let index = packages.firstIndex(where: { $0.progress == nil && $0.name == LoadingPackage(id: id).name }) {
      packages[index].id = id
      return index
    }
    packages.append(LoadingPackage(id: id))
    return packages.count - 1
  }
}

struct LoadingPackage: Identifiable {
  var id: String
  var progress: PackageProgress?
  var loaded = false
  var name: String { String(id.split(separator: "@").first ?? Substring(id)) }
  var ready: Bool { loaded || progress?.phase == .ready }
  var percent: Double? { progress?.phase == .downloading ? progress?.download.percent : nil }
  var status: String {
    if ready { return "Loaded" }
    switch progress?.phase {
    case .resolving: return "Resolving"
    case .downloading: return percent.map { "\(Int($0))%" } ?? "Downloading"
    case .loading: return "Preparing"
    default: return "Waiting"
    }
  }
}

struct ShellLoadingView: View {
  let state: ShellLoadingState
  let retry: () -> Void

  var body: some View {
    GeometryReader { geometry in
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          if let error = state.error {
            Text(error).font(.system(size: 13)).foregroundStyle(ShellTheme.muted).padding(.bottom, 16)
          }
          LoadingRow(name: "Wasmer SDK", status: state.sdkLoaded ? "Loaded" : "Initializing",
            ready: state.sdkLoaded, percent: nil, waiting: false, stopped: state.error != nil)
          ForEach(state.packages) { package in
            LoadingRow(name: package.name, status: package.status,
              ready: package.ready, percent: package.percent, waiting: package.progress == nil, stopped: state.error != nil)
          }
          if state.error != nil {
            Button("Try again", action: retry).buttonStyle(ShellButtonStyle(isSelected: true)).padding(.top, 20)
          }
        }
        .frame(maxWidth: 320)
        .padding(24)
        .frame(maxWidth: .infinity, minHeight: geometry.size.height, alignment: .center)
      }
    }
    .background(ShellTheme.panel)
  }
}

private struct LoadingRow: View {
  let name: String
  let status: String
  let ready: Bool
  let percent: Double?
  let waiting: Bool
  let stopped: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    HStack(spacing: 10) {
      ZStack {
        if ready {
          Image(systemName: "checkmark").font(.system(size: 11, weight: .medium)).foregroundStyle(ShellTheme.muted)
        } else if stopped {
          Image(systemName: "minus").foregroundStyle(ShellTheme.muted)
        } else if let percent {
          Circle().stroke(.white.opacity(0.15), lineWidth: 1.5)
          Circle().trim(from: 0, to: min(1, max(0, percent / 100)))
            .stroke(ShellTheme.text, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            .rotationEffect(.degrees(-90))
        } else if waiting || reduceMotion {
          Circle().trim(from: 0, to: waiting ? 1 : 0.75)
            .stroke(waiting ? ShellTheme.muted.opacity(0.3) : ShellTheme.text, lineWidth: 1.5)
        } else {
          ProgressView().controlSize(.mini).tint(ShellTheme.text)
        }
      }.frame(width: 16, height: 16).accessibilityHidden(true)
      Text(name).font(.system(size: 15))
        .foregroundStyle(ready || waiting || stopped ? ShellTheme.muted : ShellTheme.text)
      if let percent, !ready, !stopped {
        Text("\(Int(percent))%").font(.system(size: 12)).foregroundStyle(ShellTheme.muted).monospacedDigit().fixedSize()
      }
    }
    .frame(minHeight: 34, alignment: .leading)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(name)
    .accessibilityValue(stopped && !ready ? "Stopped" : status)
  }
}

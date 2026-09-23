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
  var version: String { id.split(separator: "@").dropFirst().first.map { String($0).replacingOccurrences(of: "=", with: "") } ?? "" }
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
  var detail: String {
    if ready { return progress?.cached == true ? "Cached" : version }
    guard let download = progress?.download,
      download.downloadedBytes > 0 || (download.totalBytes ?? 0) > 0 else { return version }
    let received = Double(download.downloadedBytes) / 1_000_000
    if let total = download.totalBytes { return String(format: "%.1f / %.1f MB", received, Double(total) / 1_000_000) }
    return String(format: "%.1f MB", received)
  }
}

struct ShellLoadingView: View {
  let state: ShellLoadingState
  let status: String
  let retry: () -> Void

  var body: some View {
    GeometryReader { geometry in
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          Text(state.error == nil ? "Starting your shell" : "The shell could not start")
            .font(.system(size: 22, weight: .medium)).tracking(-0.7)
          Text(state.error ?? status)
            .font(.system(size: 13)).foregroundStyle(ShellTheme.muted)
            .padding(.top, 8).padding(.bottom, 24)
          LoadingRow(name: "Wasmer SDK", detail: "", status: state.sdkLoaded ? "Loaded" : "Initializing",
            ready: state.sdkLoaded, percent: nil, waiting: false, stopped: state.error != nil)
          Divider().padding(.top, 6).padding(.bottom, 8)
          ForEach(state.packages) { package in
            LoadingRow(name: package.name, detail: package.detail, status: package.status,
              ready: package.ready, percent: package.percent, waiting: package.progress == nil, stopped: state.error != nil)
              .frame(minHeight: 64)
          }
          if state.error != nil {
            Button("Try again", action: retry).buttonStyle(ShellButtonStyle(isSelected: true)).padding(.top, 20)
          }
        }
        .frame(maxWidth: 400)
        .padding(24)
        .frame(maxWidth: .infinity, minHeight: geometry.size.height, alignment: .center)
      }
    }
    .background(ShellTheme.panel)
  }
}

private struct LoadingRow: View {
  let name: String
  let detail: String
  let status: String
  let ready: Bool
  let percent: Double?
  let waiting: Bool
  let stopped: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  private let green = Color(red: 94 / 255, green: 230 / 255, blue: 168 / 255)

  var body: some View {
    HStack(spacing: 14) {
      ZStack {
        if ready {
          Image(systemName: "checkmark").font(.system(size: 15, weight: .medium)).foregroundStyle(green)
        } else if stopped {
          Image(systemName: "minus").foregroundStyle(ShellTheme.muted)
        } else if let percent {
          Circle().stroke(.white.opacity(0.15), lineWidth: 2)
          Circle().trim(from: 0, to: min(1, max(0, percent / 100)))
            .stroke(Color(uiColor: ShellTheme.cursor), style: StrokeStyle(lineWidth: 2, lineCap: .round))
            .rotationEffect(.degrees(-90))
        } else if waiting || reduceMotion {
          Circle().trim(from: 0, to: waiting ? 1 : 0.75)
            .stroke(waiting ? ShellTheme.muted.opacity(0.3) : Color(uiColor: ShellTheme.cursor), lineWidth: 2)
        } else {
          ProgressView().tint(Color(uiColor: ShellTheme.cursor))
        }
      }.frame(width: 28, height: 28).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 4) {
        Text(name).font(.system(size: 14))
        if !detail.isEmpty { Text(detail).font(.system(size: 12)).foregroundStyle(ShellTheme.muted).monospacedDigit() }
      }.frame(maxWidth: .infinity, alignment: .leading)
      Text(stopped && !ready ? "Stopped" : status).font(.system(size: 12))
        .foregroundStyle(ready ? green : ShellTheme.muted).monospacedDigit().fixedSize()
    }
    .padding(.vertical, 10)
    .accessibilityElement(children: .combine)
  }
}

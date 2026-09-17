// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "WasmerWebKitPrototype",
  platforms: [.iOS("27.0"), .macOS(.v14)],
  products: [.library(name: "WasmerWebKit", targets: ["WasmerWebKit"])],
  targets: [
    .target(name: "WasmerWebKit", resources: [.copy("Web")]),
    .testTarget(name: "WasmerWebKitTests", dependencies: ["WasmerWebKit"]),
  ]
)

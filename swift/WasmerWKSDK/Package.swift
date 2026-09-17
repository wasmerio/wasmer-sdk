// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "WasmerWKSDK",
  platforms: [.iOS("27.0"), .macOS(.v14)],
  products: [.library(name: "WasmerWKSDK", type: .static, targets: ["WasmerWKSDK"])],
  targets: [
    .target(name: "WasmerWKSDK", resources: [.copy("Web")]),
    .testTarget(name: "WasmerWKSDKTests", dependencies: ["WasmerWKSDK"]),
  ]
)

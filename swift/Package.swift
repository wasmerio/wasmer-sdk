// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "WasmerSDK",
  platforms: [.macOS(.v12), .iOS("27.0")],
  products: [
    .library(name: "WasmerSDK", targets: ["WasmerSDK"]),
    .executable(name: "WasmerDemo", targets: ["WasmerDemo"]),
  ],
  targets: [
    .binaryTarget(name: "WasmerSDKFFI", path: "Artifacts/WasmerSDKFFI.xcframework"),
    .target(
      name: "WasmerSDKCore",
      dependencies: [.target(name: "WasmerSDKFFI", condition: .when(platforms: [.macOS]))],
      linkerSettings: [
        .linkedLibrary("c++"),
        .linkedLibrary("iconv"),
        .linkedLibrary("resolv"),
        .linkedFramework("Security"),
        .linkedFramework("SystemConfiguration"),
        .linkedFramework("CoreFoundation"),
      ]
    ),
    .target(name: "WasmerSDK", dependencies: [
      .target(name: "WasmerSDKCore", condition: .when(platforms: [.macOS])),
      .target(name: "WasmerWKSDK", condition: .when(platforms: [.iOS])),
    ]),
    .target(name: "WasmerWKSDK", path: "WasmerWKSDK/Sources/WasmerWKSDK", resources: [.copy("Web")]),
    .executableTarget(
      name: "WasmerDemo", dependencies: ["WasmerSDK"],
      path: "Examples/WasmerDemo"
    ),
    .testTarget(
      name: "WasmerSDKTests",
      dependencies: ["WasmerSDK"],
      resources: [.copy("Fixtures")]
    ),
  ]
)

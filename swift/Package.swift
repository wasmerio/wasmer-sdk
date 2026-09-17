// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "WasmerSDK",
  platforms: [.macOS(.v12)],
  products: [
    .library(name: "WasmerSDK", targets: ["WasmerSDK"]),
    .executable(name: "WasmerDemo", targets: ["WasmerDemo"]),
  ],
  targets: [
    .binaryTarget(name: "WasmerSDKFFI", path: "Artifacts/WasmerSDKFFI.xcframework"),
    .target(
      name: "WasmerSDKCore",
      dependencies: ["WasmerSDKFFI"],
      linkerSettings: [
        .linkedLibrary("c++"),
        .linkedLibrary("iconv"),
        .linkedLibrary("resolv"),
        .linkedFramework("Security"),
        .linkedFramework("SystemConfiguration"),
        .linkedFramework("CoreFoundation"),
      ]
    ),
    .target(name: "WasmerSDK", dependencies: ["WasmerSDKCore"]),
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

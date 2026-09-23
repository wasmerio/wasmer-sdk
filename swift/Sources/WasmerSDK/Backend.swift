// Backend selection is internal; applications always import WasmerSDK.
#if os(iOS)
  import WasmerWKSDK
  public typealias DownloadProgress = WasmerWKSDK.DownloadProgress
  public typealias PackageLoadPhase = WasmerWKSDK.PackageLoadPhase
  public typealias PackageProgress = WasmerWKSDK.PackageProgress
  public typealias PackageLoadProgress = WasmerWKSDK.PackageLoadProgress
  typealias CorePackageLoadObserver = WasmerWKSDK.PackageLoadObserver
  typealias CorePackageLoadCancellation = WasmerWKSDK.PackageLoadCancellation
  typealias CorePackageLoadSource = WasmerWKSDK.PackageLoadSource
  public typealias SdkError = WasmerWKSDK.SdkError
  public typealias NetworkMode = WasmerWKSDK.NetworkMode
  public typealias ProcessExitReason = WasmerWKSDK.ProcessExitReason
  public typealias ProcessOutput = WasmerWKSDK.ProcessOutput
  public typealias FileKind = WasmerWKSDK.FileKind
  public typealias FileStat = WasmerWKSDK.FileStat
  public typealias DirectoryEntry = WasmerWKSDK.DirectoryEntry
  public typealias InputMode = WasmerWKSDK.InputMode
  public typealias OutputMode = WasmerWKSDK.OutputMode
  typealias WasmerCore = WasmerWKSDK.WasmerCore
  typealias ClientOptions = WasmerWKSDK.ClientOptions
  typealias PackageCore = WasmerWKSDK.PackageCore
  typealias CommandRefCore = WasmerWKSDK.CommandRefCore
  typealias SandboxCore = WasmerWKSDK.SandboxCore
  typealias CommandCore = WasmerWKSDK.CommandCore
  typealias RunOptions = WasmerWKSDK.RunOptions
  typealias SpawnOptions = WasmerWKSDK.SpawnOptions
  typealias ProcessCore = WasmerWKSDK.ProcessCore
  typealias FileSystemCore = WasmerWKSDK.FileSystemCore
  typealias PortsCore = WasmerWKSDK.PortsCore
  typealias CorePackageDefinition = WasmerWKSDK.PackageDefinition
  typealias CorePackageCommandDefinition = WasmerWKSDK.PackageCommandDefinition
#else
  import WasmerSDKCore
  public typealias DownloadProgress = WasmerSDKCore.DownloadProgress
  public typealias PackageLoadPhase = WasmerSDKCore.PackageLoadPhase
  public typealias PackageProgress = WasmerSDKCore.PackageProgress
  public typealias PackageLoadProgress = WasmerSDKCore.PackageLoadProgress
  typealias CorePackageLoadObserver = WasmerSDKCore.PackageLoadObserver
  typealias CorePackageLoadCancellation = WasmerSDKCore.PackageLoadCancellation
  typealias CorePackageLoadSource = WasmerSDKCore.PackageLoadSource
  public typealias SdkError = WasmerSDKCore.SdkError
  public typealias NetworkMode = WasmerSDKCore.NetworkMode
  public typealias ProcessExitReason = WasmerSDKCore.ProcessExitReason
  public typealias ProcessOutput = WasmerSDKCore.ProcessOutput
  public typealias FileKind = WasmerSDKCore.FileKind
  public typealias FileStat = WasmerSDKCore.FileStat
  public typealias DirectoryEntry = WasmerSDKCore.DirectoryEntry
  public typealias InputMode = WasmerSDKCore.InputMode
  public typealias OutputMode = WasmerSDKCore.OutputMode
  typealias WasmerCore = WasmerSDKCore.WasmerCore
  typealias ClientOptions = WasmerSDKCore.ClientOptions
  typealias PackageCore = WasmerSDKCore.PackageCore
  typealias CommandRefCore = WasmerSDKCore.CommandRefCore
  typealias SandboxCore = WasmerSDKCore.SandboxCore
  typealias CommandCore = WasmerSDKCore.CommandCore
  typealias RunOptions = WasmerSDKCore.RunOptions
  typealias SpawnOptions = WasmerSDKCore.SpawnOptions
  typealias ProcessCore = WasmerSDKCore.ProcessCore
  typealias FileSystemCore = WasmerSDKCore.FileSystemCore
  typealias PortsCore = WasmerSDKCore.PortsCore
  typealias CorePackageDefinition = WasmerSDKCore.PackageDefinition
  typealias CorePackageCommandDefinition = WasmerSDKCore.PackageCommandDefinition
#endif

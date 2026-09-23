use crate::{PackageCore, SdkError, WasmerCore};
use std::sync::Arc;

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum PackageLoadPhase {
    Resolving,
    Downloading,
    Loading,
    Ready,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct DownloadProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub percent: Option<f64>,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct PackageProgress {
    pub id: String,
    pub phase: PackageLoadPhase,
    pub cached: bool,
    pub download: DownloadProgress,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct PackageLoadProgress {
    pub phase: PackageLoadPhase,
    pub download: DownloadProgress,
    pub packages: Vec<PackageProgress>,
}

impl From<wasmer_sdk::PackageLoadPhase> for PackageLoadPhase {
    fn from(value: wasmer_sdk::PackageLoadPhase) -> Self {
        match value {
            wasmer_sdk::PackageLoadPhase::Resolving => Self::Resolving,
            wasmer_sdk::PackageLoadPhase::Downloading => Self::Downloading,
            wasmer_sdk::PackageLoadPhase::Loading => Self::Loading,
            wasmer_sdk::PackageLoadPhase::Ready => Self::Ready,
        }
    }
}
impl From<wasmer_sdk::DownloadProgress> for DownloadProgress {
    fn from(value: wasmer_sdk::DownloadProgress) -> Self {
        Self {
            downloaded_bytes: value.downloaded_bytes,
            total_bytes: value.total_bytes,
            percent: value.percent,
        }
    }
}
impl From<wasmer_sdk::PackageLoadProgress> for PackageLoadProgress {
    fn from(value: wasmer_sdk::PackageLoadProgress) -> Self {
        Self {
            phase: value.phase.into(),
            download: value.download.into(),
            packages: value
                .packages
                .into_iter()
                .map(|p| PackageProgress {
                    id: p.id,
                    phase: p.phase.into(),
                    cached: p.cached,
                    download: p.download.into(),
                })
                .collect(),
        }
    }
}

#[uniffi::export(callback_interface)]
pub trait PackageLoadObserver: Send + Sync {
    fn on_progress(&self, progress: PackageLoadProgress);
}

#[derive(Debug, uniffi::Object)]
pub struct PackageLoadCancellation {
    inner: wasmer_sdk::PackageLoadCancellation,
}

#[uniffi::export]
impl PackageLoadCancellation {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Default::default(),
        })
    }
    pub fn cancel(&self) {
        self.inner.cancel();
    }
}

#[derive(Clone, Debug, uniffi::Enum)]
pub enum PackageLoadSource {
    Registry { specifier: String },
    Path { path: String },
    Bytes { bytes: Vec<u8> },
    Package { package: Arc<PackageCore> },
}

impl From<PackageLoadSource> for wasmer_sdk::PackageSource {
    fn from(source: PackageLoadSource) -> Self {
        match source {
            PackageLoadSource::Registry { specifier } => Self::Registry(specifier),
            PackageLoadSource::Path { path } => Self::Path(path.into()),
            PackageLoadSource::Bytes { bytes } => Self::Bytes(bytes.into()),
            PackageLoadSource::Package { package } => Self::Package(package.inner.clone()),
        }
    }
}

#[uniffi::export]
impl WasmerCore {
    pub async fn load_packages(
        &self,
        sources: Vec<PackageLoadSource>,
        observer: Option<Box<dyn PackageLoadObserver>>,
        cancellation: Option<Arc<PackageLoadCancellation>>,
    ) -> Result<Vec<Arc<PackageCore>>, SdkError> {
        let cancellation = cancellation.unwrap_or_else(PackageLoadCancellation::new);
        // UniFFI may drop this outer future while RuntimeContext is still
        // running the task. Cancel its inner work instead of detaching a download.
        struct CancelOnDrop(Arc<PackageLoadCancellation>);
        impl Drop for CancelOnDrop {
            fn drop(&mut self) {
                self.0.cancel();
            }
        }
        let _cancel = CancelOnDrop(cancellation.clone());
        let mut options =
            wasmer_sdk::PackageLoadOptions::default().cancellation(cancellation.inner.clone());
        if let Some(observer) = observer {
            options = options.on_progress(move |p| observer.on_progress(p.into()));
        }
        let client = self.inner.clone();
        let packages = self
            .context
            .sdk(async move {
                client
                    .packages()
                    .load_many_with_options(
                        sources.into_iter().map(wasmer_sdk::PackageSource::from),
                        options,
                    )
                    .await
            })
            .await?;
        Ok(packages
            .into_iter()
            .map(|p| Arc::new(PackageCore::new(self.context.clone(), p)))
            .collect())
    }
}

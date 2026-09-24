//! Operation-scoped package acquisition progress shared by every binding.
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fmt,
    future::Future,
    sync::{Arc, Mutex},
    time::Duration,
};

use futures::{
    FutureExt,
    future::{BoxFuture, WeakShared},
};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use wasmer_wasix::{
    bin_factory::BinaryPackage,
    runtime::{
        package_loader::{PackageDownloadPhase, PackageDownloadProgress, PackageLoader},
        resolver::{PackageSummary, Resolution, WebcHash},
    },
};
use webc::Container;

use crate::{Error, Package, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PackageLoadPhase {
    Resolving,
    Downloading,
    Loading,
    Ready,
}

/// Decoded package-body bytes. Cache hits and local sources contribute zero.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    /// Download completion from 0 to 100; unknown totals have no percentage.
    pub percent: Option<f64>,
}

impl DownloadProgress {
    fn new(downloaded_bytes: u64, total_bytes: Option<u64>) -> Self {
        let total_bytes = total_bytes.filter(|total| *total >= downloaded_bytes);
        Self {
            downloaded_bytes,
            total_bytes,
            percent: total_bytes.map(|total| {
                if total == 0 {
                    100.0
                } else {
                    100.0 * downloaded_bytes as f64 / total as f64
                }
            }),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageProgress {
    pub id: String,
    pub phase: PackageLoadPhase,
    pub cached: bool,
    pub download: DownloadProgress,
}

/// A snapshot, not a delta. Download completion does not imply load readiness.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageLoadProgress {
    pub phase: PackageLoadPhase,
    pub download: DownloadProgress,
    pub packages: Vec<PackageProgress>,
}

/// Cancellation for a load operation; shared acquisitions remain alive for
/// other callers. Dropping a Rust load future also cancels its interest.
#[derive(Clone, Debug)]
pub struct PackageLoadCancellation(watch::Sender<bool>);

impl Default for PackageLoadCancellation {
    fn default() -> Self {
        Self(watch::channel(false).0)
    }
}

impl PackageLoadCancellation {
    pub fn cancel(&self) {
        self.0.send_replace(true);
    }
    pub fn is_cancelled(&self) -> bool {
        *self.0.borrow()
    }
    async fn cancelled(&self) {
        let mut receiver = self.0.subscribe();
        while !*receiver.borrow_and_update() {
            if receiver.changed().await.is_err() {
                break;
            }
        }
    }
}

#[derive(Clone, Default)]
pub struct PackageLoadOptions {
    pub(crate) observer: Option<Arc<dyn Fn(PackageLoadProgress) + Send + Sync>>,
    pub(crate) cancellation: Option<PackageLoadCancellation>,
}

impl fmt::Debug for PackageLoadOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PackageLoadOptions")
            .field("observed", &self.observer.is_some())
            .field("cancellation", &self.cancellation)
            .finish()
    }
}

impl PackageLoadOptions {
    #[must_use]
    pub fn on_progress(
        mut self,
        observer: impl Fn(PackageLoadProgress) + Send + Sync + 'static,
    ) -> Self {
        self.observer = Some(Arc::new(observer));
        self
    }
    #[must_use]
    pub fn cancellation(mut self, cancellation: PackageLoadCancellation) -> Self {
        self.cancellation = Some(cancellation);
        self
    }
}

#[derive(Debug)]
struct State {
    resolving: usize,
    packages: BTreeMap<String, PackageProgress>,
}

#[derive(Clone, Debug)]
pub(crate) struct Progress {
    state: Arc<Mutex<State>>,
    changed: watch::Sender<()>,
}

impl Progress {
    pub(crate) fn new(roots: usize) -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                resolving: roots,
                packages: BTreeMap::new(),
            })),
            changed: watch::channel(()).0,
        }
    }
    fn change(&self, update: impl FnOnce(&mut State)) {
        update(&mut self.state.lock().expect("progress lock poisoned"));
        self.changed.send_replace(());
    }
    pub(crate) fn local(&self, package: &Package, cached: bool) {
        self.change(|state| {
            state.resolving = state.resolving.saturating_sub(1);
            state
                .packages
                .entry(format!("local:{}", package.id()))
                .or_insert(PackageProgress {
                    id: package.id().to_string(),
                    phase: PackageLoadPhase::Ready,
                    cached,
                    download: DownloadProgress::new(0, Some(0)),
                });
        });
    }
    fn resolved(&self, root: Option<&PackageSummary>, resolution: &Resolution) {
        self.change(|state| {
            state.resolving = state.resolving.saturating_sub(1);
            if let Some(root) = root {
                register(state, root);
            } else {
                let id = resolution.package.root_package.to_string();
                state
                    .packages
                    .entry(format!("local:{id}"))
                    .or_insert(PackageProgress {
                        id,
                        phase: PackageLoadPhase::Loading,
                        cached: false,
                        download: DownloadProgress::new(0, Some(0)),
                    });
            }
            // Match the loader's acquisition set, not all manifest dependencies.
            let ids: HashSet<_> = resolution
                .package
                .commands
                .values()
                .map(|c| &c.package)
                .chain(resolution.package.filesystem.iter().map(|m| &m.package))
                .collect();
            for id in ids {
                if *id == resolution.package.root_package {
                    continue;
                }
                let node = &resolution.graph[id];
                if let Some(dist) = &node.dist {
                    register(
                        state,
                        &PackageSummary {
                            pkg: node.pkg.clone(),
                            dist: dist.clone(),
                        },
                    );
                }
            }
        });
    }
    fn update(&self, summary: &PackageSummary, update: PackageDownloadProgress) {
        self.change(|state| {
            let entry = register(state, summary);
            entry.phase = match update.phase {
                PackageDownloadPhase::Downloading => PackageLoadPhase::Downloading,
                PackageDownloadPhase::Loading => PackageLoadPhase::Loading,
                PackageDownloadPhase::Ready => PackageLoadPhase::Ready,
            };
            entry.cached = update.cached;
            entry.download = DownloadProgress::new(update.downloaded_bytes, update.total_bytes);
        });
    }
    fn snapshot(&self, ready: bool) -> PackageLoadProgress {
        let state = self.state.lock().expect("progress lock poisoned");
        let mut packages: Vec<_> = state.packages.values().cloned().collect();
        let mut received = 0u64;
        let mut total = Some(0u64);
        for package in &mut packages {
            received = received.saturating_add(package.download.downloaded_bytes);
            total = total.and_then(|sum| sum.checked_add(package.download.total_bytes?));
            if ready {
                package.phase = PackageLoadPhase::Ready;
            }
        }
        if state.resolving > 0 {
            total = None;
        }
        let phase = if ready {
            PackageLoadPhase::Ready
        } else if state.resolving > 0 {
            PackageLoadPhase::Resolving
        } else if packages.iter().any(|p| {
            matches!(
                p.phase,
                PackageLoadPhase::Downloading | PackageLoadPhase::Resolving
            )
        }) {
            PackageLoadPhase::Downloading
        } else {
            PackageLoadPhase::Loading
        };
        PackageLoadProgress {
            phase,
            download: DownloadProgress::new(received, total),
            packages,
        }
    }
}

fn register<'a>(state: &'a mut State, summary: &PackageSummary) -> &'a mut PackageProgress {
    state
        .packages
        .entry(summary.dist.webc_sha256.to_string())
        .or_insert_with(|| PackageProgress {
            id: summary.pkg.id.to_string(),
            phase: PackageLoadPhase::Resolving,
            cached: false,
            // A cache lookup must finish before counting this as network work.
            download: DownloadProgress::new(0, None),
        })
}

/// Drives callbacks on the caller's future, outside all loader/cache locks.
pub(crate) async fn observe<T>(
    options: PackageLoadOptions,
    progress: Option<Progress>,
    work: impl Future<Output = Result<T>>,
) -> Result<T> {
    let cancellation = options.cancellation.unwrap_or_default();
    if cancellation.is_cancelled() {
        return Err(Error::Cancelled);
    }
    tokio::pin!(work);
    let (Some(observer), Some(progress)) = (options.observer, progress) else {
        return tokio::select! {
            biased;
            () = cancellation.cancelled() => Err(Error::Cancelled),
            result = &mut work => result,
        };
    };
    let mut changes = progress.changed.subscribe();
    let initial = progress.snapshot(false);
    observer(initial.clone());
    let mut last = initial;
    let mut sent_at = instant::Instant::now();
    loop {
        tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(Error::Cancelled),
            result = &mut work => {
                if result.is_ok() { observer(progress.snapshot(true)); }
                return result;
            }
            changed = changes.changed() => {
                if changed.is_err() { continue; }
                let next = progress.snapshot(false);
                let phase_changed = next.phase != last.phase || next.packages.iter().any(|p| {
                    last.packages.iter().find(|old| old.id == p.id).is_none_or(|old| old.phase != p.phase)
                });
                if phase_changed || sent_at.elapsed() >= Duration::from_millis(100) {
                    observer(next.clone()); last = next; sent_at = instant::Instant::now();
                }
            }
        }
    }
}

type Acquisition = BoxFuture<'static, std::result::Result<Container, Arc<str>>>;
struct Flight {
    future: WeakShared<Acquisition>,
    updates: watch::Sender<Option<PackageDownloadProgress>>,
}

/// Weak futures keep downloads alive only while callers still need them.
pub(crate) struct SharedPackageLoader {
    inner: Arc<dyn PackageLoader + Send + Sync>,
    flights: Arc<Mutex<HashMap<WebcHash, Flight>>>,
    progress: Option<Progress>,
}

impl fmt::Debug for SharedPackageLoader {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SharedPackageLoader")
            .finish_non_exhaustive()
    }
}

impl SharedPackageLoader {
    pub(crate) fn new(inner: Arc<dyn PackageLoader + Send + Sync>) -> Self {
        Self {
            inner,
            flights: Arc::default(),
            progress: None,
        }
    }
    pub(crate) fn observing(&self, progress: Progress) -> Self {
        Self {
            inner: self.inner.clone(),
            flights: self.flights.clone(),
            progress: Some(progress),
        }
    }
}

#[async_trait::async_trait]
impl PackageLoader for SharedPackageLoader {
    async fn load(&self, summary: &PackageSummary) -> anyhow::Result<Container> {
        let (future, mut updates) = {
            let mut flights = self.flights.lock().expect("acquisition lock poisoned");
            if let Some((future, receiver)) = flights
                .get(&summary.dist.webc_sha256)
                .and_then(|flight| Some((flight.future.upgrade()?, flight.updates.subscribe())))
            {
                (future, receiver)
            } else {
                flights.retain(|_, flight| flight.future.upgrade().is_some());
                let (updates, receiver) = watch::channel(None);
                let sender = updates.clone();
                let loader = self.inner.clone();
                let summary = summary.clone();
                let hash = summary.dist.webc_sha256;
                let future: Acquisition = Box::pin(async move {
                    loader
                        .load_with_progress(
                            &summary,
                            Some(Arc::new(move |progress| {
                                sender.send_replace(Some(progress));
                            })),
                        )
                        .await
                        .map_err(|error| Arc::from(format!("{error:#}")))
                });
                let future = future.shared();
                flights.insert(
                    hash,
                    Flight {
                        future: future.downgrade().expect("new future"),
                        updates,
                    },
                );
                (future, receiver)
            }
        };
        tokio::pin!(future);
        loop {
            if let (Some(progress), Some(update)) =
                (&self.progress, updates.borrow_and_update().clone())
            {
                progress.update(summary, update);
            }
            tokio::select! {
                result = &mut future => {
                    if let Some(progress) = &self.progress {
                        let update = updates.borrow().clone().unwrap_or(PackageDownloadProgress {
                            phase: PackageDownloadPhase::Ready, downloaded_bytes: 0, total_bytes: Some(0), cached: false,
                        });
                        progress.update(summary, update);
                    }
                    return result.map_err(|error| anyhow::anyhow!("{error}"));
                }
                changed = updates.changed(), if self.progress.is_some() => {
                    if changed.is_err() { return future.await.map_err(|error| anyhow::anyhow!("{error}")); }
                }
            }
        }
    }
    fn resolved(&self, root: Option<&PackageSummary>, resolution: &Resolution) {
        if let Some(progress) = &self.progress {
            progress.resolved(root, resolution);
        }
    }
    async fn load_package_tree(
        &self,
        root: &Container,
        resolution: &Resolution,
        local: bool,
    ) -> anyhow::Result<BinaryPackage> {
        wasmer_wasix::runtime::package_loader::load_package_tree(root, self, resolution, local)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package(id: &str, received: u64, total: Option<u64>, cached: bool) -> PackageProgress {
        PackageProgress {
            id: id.into(),
            phase: PackageLoadPhase::Downloading,
            cached,
            download: DownloadProgress::new(received, total),
        }
    }

    #[test]
    fn aggregate_is_weighted_and_unknown_until_every_total_is_known() {
        let progress = Progress::new(1);
        progress.change(|state| {
            state
                .packages
                .insert("small".into(), package("small", 10, Some(10), false));
            state
                .packages
                .insert("large".into(), package("large", 0, Some(90), false));
            state
                .packages
                .insert("cached".into(), package("cached", 0, Some(0), true));
        });
        assert_eq!(progress.snapshot(false).download.percent, None);
        progress.change(|state| state.resolving = 0);
        assert_eq!(progress.snapshot(false).download.percent, Some(10.0));
        progress.change(|state| {
            state.packages.get_mut("large").unwrap().download = DownloadProgress::new(20, None)
        });
        let snapshot = progress.snapshot(false);
        assert_eq!(snapshot.download.downloaded_bytes, 30);
        assert_eq!(snapshot.download.total_bytes, None);
        assert_eq!(snapshot.download.percent, None);
        assert_eq!(DownloadProgress::new(101, Some(100)).percent, None);
    }

    #[tokio::test]
    async fn empty_and_local_loads_finish_before_return_without_network_bytes() {
        let cache = tempfile::tempdir().unwrap();
        let client = crate::Wasmer::with_config(crate::WasmerConfig {
            cache: crate::CacheConfig {
                root: cache.path().into(),
            },
            ..Default::default()
        })
        .unwrap();
        let snapshots = Arc::new(Mutex::new(Vec::new()));
        for sources in [
            vec![],
            vec![crate::PackageSource::bytes(
                wat::parse_str("(module (func (export \"_start\")))").unwrap(),
            )],
        ] {
            let count = sources.len();
            let captured = snapshots.clone();
            let result = client
                .packages()
                .load_many_with_options(
                    sources,
                    PackageLoadOptions::default()
                        .on_progress(move |p| captured.lock().unwrap().push(p)),
                )
                .await
                .unwrap();
            assert_eq!(result.len(), count);
            let final_state = snapshots.lock().unwrap().last().unwrap().clone();
            assert_eq!(final_state.phase, PackageLoadPhase::Ready);
            assert_eq!(final_state.download, DownloadProgress::new(0, Some(0)));
        }
    }

    #[tokio::test]
    async fn cancellation_and_failure_never_report_ready() {
        let token = PackageLoadCancellation::default();
        let captured = Arc::new(Mutex::new(Vec::new()));
        let progress = Progress::new(1);
        let events = captured.clone();
        let options = PackageLoadOptions::default()
            .cancellation(token.clone())
            .on_progress(move |p| events.lock().unwrap().push(p));
        let work = async {
            token.cancel();
            futures::future::pending::<Result<()>>().await
        };
        assert!(matches!(
            observe(options, Some(progress), work).await,
            Err(Error::Cancelled)
        ));
        assert!(
            captured
                .lock()
                .unwrap()
                .iter()
                .all(|p| p.phase != PackageLoadPhase::Ready)
        );
    }
}

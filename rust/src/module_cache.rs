use futures::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use wasmer::{Engine, Module};
use wasmer_types::ModuleHash;
use wasmer_wasix::runtime::module_cache::{CacheError, ModuleCache};

type Key = (ModuleHash, String, String);
type SharedLoad = Shared<BoxFuture<'static, Result<Module, Arc<CacheError>>>>;
type Loads = Arc<Mutex<HashMap<Key, Entry>>>;

struct Entry {
    load: SharedLoad,
    waiters: usize,
}

/// Coalesces overlapping artifact reads, including preloads and commands.
/// The last waiter removes its entry even if its future was cancelled.
pub(crate) struct SingleFlight<C> {
    inner: Arc<C>,
    loads: Loads,
}

impl<C> SingleFlight<C> {
    pub(crate) fn new(inner: C) -> Self {
        Self {
            inner: Arc::new(inner),
            loads: Arc::default(),
        }
    }
}

impl<C: std::fmt::Debug> std::fmt::Debug for SingleFlight<C> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SingleFlight")
            .field("inner", &self.inner)
            .finish_non_exhaustive()
    }
}

struct Waiter {
    key: Key,
    load: SharedLoad,
    loads: Loads,
}

impl Drop for Waiter {
    fn drop(&mut self) {
        let mut loads = self
            .loads
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(entry) = loads.get_mut(&self.key)
            && entry.load.ptr_eq(&self.load)
        {
            entry.waiters -= 1;
            if entry.waiters == 0 {
                loads.remove(&self.key);
            }
        }
    }
}

#[async_trait::async_trait]
impl<C: ModuleCache + Send + Sync + 'static> ModuleCache for SingleFlight<C> {
    async fn load(&self, key: ModuleHash, engine: &Engine) -> Result<Module, CacheError> {
        let id = (key, engine.deterministic_id(), engine.artifact_format());
        let waiter = {
            let mut loads = self
                .loads
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let entry = loads.entry(id.clone()).or_insert_with(|| {
                let (inner, engine) = (Arc::clone(&self.inner), engine.clone());
                Entry {
                    load: async move { inner.load(key, &engine).await.map_err(Arc::new) }
                        .boxed()
                        .shared(),
                    waiters: 0,
                }
            });
            entry.waiters += 1;
            Waiter {
                key: id,
                load: entry.load.clone(),
                loads: Arc::clone(&self.loads),
            }
        };
        let result = waiter.load.clone().await;
        drop(waiter);
        result.map_err(|error| match Arc::try_unwrap(error) {
            Ok(error) => error,
            Err(error) => match error.as_ref() {
                CacheError::NotFound => CacheError::NotFound,
                other => CacheError::Other(other.to_string().into()),
            },
        })
    }

    async fn contains(&self, key: ModuleHash, engine: &Engine) -> Result<bool, CacheError> {
        self.inner.contains(key, engine).await
    }

    async fn save(
        &self,
        key: ModuleHash,
        engine: &Engine,
        module: &Module,
    ) -> Result<(), CacheError> {
        self.inner.save(key, engine, module).await
    }
}

#[cfg(all(test, feature = "sys"))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tokio::sync::{Notify, Semaphore};

    #[derive(Debug)]
    struct Cache {
        calls: AtomicUsize,
        started: Notify,
        gate: Semaphore,
        missing: AtomicBool,
        module: Module,
    }

    #[async_trait::async_trait]
    impl ModuleCache for Cache {
        async fn load(&self, _: ModuleHash, _: &Engine) -> Result<Module, CacheError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.started.notify_one();
            self.gate.acquire().await.unwrap().forget();
            if self.missing.load(Ordering::SeqCst) {
                Err(CacheError::NotFound)
            } else {
                Ok(self.module.clone())
            }
        }
        async fn contains(&self, _: ModuleHash, _: &Engine) -> Result<bool, CacheError> {
            Ok(true)
        }
        async fn save(&self, _: ModuleHash, _: &Engine, _: &Module) -> Result<(), CacheError> {
            Ok(())
        }
    }

    fn fixture() -> (Arc<SingleFlight<Cache>>, Engine, ModuleHash) {
        let engine = Engine::default();
        let bytes = wat::parse_str("(module)").unwrap();
        let module = Module::new(&engine, &bytes).unwrap();
        (
            Arc::new(SingleFlight::new(Cache {
                calls: AtomicUsize::new(0),
                started: Notify::new(),
                gate: Semaphore::new(0),
                missing: AtomicBool::new(false),
                module,
            })),
            engine,
            ModuleHash::sha256(&bytes),
        )
    }

    fn load(
        cache: &Arc<SingleFlight<Cache>>,
        engine: &Engine,
        key: ModuleHash,
    ) -> tokio::task::JoinHandle<Result<Module, CacheError>> {
        let (cache, engine) = (Arc::clone(cache), engine.clone());
        tokio::spawn(async move { cache.load(key, &engine).await })
    }

    async fn waiters(cache: &SingleFlight<Cache>, count: usize) {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let actual: usize = cache
                    .loads
                    .lock()
                    .unwrap()
                    .values()
                    .map(|entry| entry.waiters)
                    .sum();
                if actual == count {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("load waiters did not make progress");
    }

    #[tokio::test]
    async fn overlapping_loads_share_one_artifact_read() {
        let (cache, engine, key) = fixture();
        let tasks: Vec<_> = (0..16).map(|_| load(&cache, &engine, key)).collect();
        waiters(&cache, 16).await;
        assert_eq!(cache.inner.calls.load(Ordering::SeqCst), 1);
        cache.inner.gate.add_permits(1);
        for task in tasks {
            task.await.unwrap().unwrap();
        }
        assert!(cache.loads.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancelling_one_waiter_preserves_the_others() {
        let (cache, engine, key) = fixture();
        let first = load(&cache, &engine, key);
        let second = load(&cache, &engine, key);
        waiters(&cache, 2).await;
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());
        waiters(&cache, 1).await;
        cache.inner.gate.add_permits(1);
        second.await.unwrap().unwrap();
        assert_eq!(cache.inner.calls.load(Ordering::SeqCst), 1);
        assert!(cache.loads.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_last_cancelled_waiter_releases_the_load_and_a_retry_can_finish() {
        let (cache, engine, key) = fixture();
        let first = load(&cache, &engine, key);
        cache.inner.started.notified().await;
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());
        assert!(cache.loads.lock().unwrap().is_empty());
        let retry = load(&cache, &engine, key);
        cache.inner.started.notified().await;
        cache.inner.gate.add_permits(1);
        retry.await.unwrap().unwrap();
        assert_eq!(cache.inner.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_failed_load_is_retried_and_engine_identities_are_separate() {
        let (cache, engine, key) = fixture();
        cache.inner.missing.store(true, Ordering::SeqCst);
        cache.inner.gate.add_permits(1);
        assert!(matches!(
            cache.load(key, &engine).await,
            Err(CacheError::NotFound)
        ));
        assert!(cache.loads.lock().unwrap().is_empty());
        cache.inner.missing.store(false, Ordering::SeqCst);
        let other: Engine =
            wasmer::sys::engine::Engine::headless_with_identity("other-engine", "other-format")
                .into();
        let first = load(&cache, &engine, key);
        let second = load(&cache, &other, key);
        waiters(&cache, 2).await;
        assert_eq!(cache.loads.lock().unwrap().len(), 2);
        cache.inner.gate.add_permits(2);
        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();
        assert_eq!(cache.inner.calls.load(Ordering::SeqCst), 3);
    }
}

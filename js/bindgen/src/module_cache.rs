use async_trait::async_trait;
use crossbeam_skiplist::SkipMap;
use wasmer::{Engine, Module};
use wasmer_types::ModuleHash;
use wasmer_wasix::runtime::module_cache::{CacheError, ModuleCache};

/// The SDK transfers shared module handles with every worker task, so compiled
/// modules and their retained bytes can be cached once for the whole client.
/// The default JS thread-local cache duplicates Python in every worker. A
/// blocking map is also unsuitable here: lookups can run on the browser main
/// thread, where a contended mutex traps instead of waiting.
#[derive(Debug, Default)]
pub(crate) struct SharedModuleCache {
    modules: SkipMap<(ModuleHash, String, String), Module>,
}

impl SharedModuleCache {
    fn key(hash: ModuleHash, engine: &Engine) -> (ModuleHash, String, String) {
        (hash, engine.deterministic_id(), engine.artifact_format())
    }
}

#[async_trait]
impl ModuleCache for SharedModuleCache {
    async fn load(&self, hash: ModuleHash, engine: &Engine) -> Result<Module, CacheError> {
        self.modules
            .get(&Self::key(hash, engine))
            .map(|entry| entry.value().clone())
            .ok_or(CacheError::NotFound)
    }

    async fn contains(&self, hash: ModuleHash, engine: &Engine) -> Result<bool, CacheError> {
        Ok(self.modules.contains_key(&Self::key(hash, engine)))
    }

    async fn save(&self, hash: ModuleHash, engine: &Engine, module: &Module) -> Result<(), CacheError> {
        self.modules.insert(Self::key(hash, engine), module.clone());
        Ok(())
    }
}

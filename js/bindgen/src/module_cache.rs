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

    async fn save(
        &self,
        hash: ModuleHash,
        engine: &Engine,
        module: &Module,
    ) -> Result<(), CacheError> {
        self.modules.insert(Self::key(hash, engine), module.clone());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;

    use bytes::Bytes;
    use wasm_bindgen_test::wasm_bindgen_test;
    use wasmer::Engine;
    use wasmer_wasix::runtime::{
        ModuleInput, load_module,
        module_cache::{HashedModuleData, ModuleCache},
    };

    use super::SharedModuleCache;

    #[wasm_bindgen_test]
    async fn cached_modules_share_the_package_buffer() {
        // A module stored at an offset inside a larger buffer, like a webc atom.
        let package = Bytes::from([b"package header".as_slice(), b"\0asm\x01\0\0\0"].concat());
        let wasm = package.slice(b"package header".len()..);
        let input = HashedModuleData::new(wasm.clone());
        let hash = *input.hash();
        let engine = Engine::default();
        let cache = SharedModuleCache::default();

        let module = load_module(&engine, &cache, ModuleInput::Hashed(Cow::Owned(input)), None)
            .await
            .unwrap();
        let cached = cache.load(hash, &engine).await.unwrap();

        // The JS backend keeps each module's binary for as long as the client
        // caches it. It must reference the package buffer, not a second copy.
        for module in [module, cached] {
            assert_eq!(module.serialize().unwrap().as_ptr(), wasm.as_ptr());
        }
    }
}

use std::{future::Future, sync::Arc};

use crate::SdkError;

#[derive(Debug)]
pub(crate) struct RuntimeContext {
    runtime: tokio::runtime::Runtime,
}

impl RuntimeContext {
    pub(crate) fn new() -> Result<Arc<Self>, SdkError> {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("wasmer-sdk-boltffi")
            .build()
            .map(|runtime| Arc::new(Self { runtime }))
            .map_err(|error| SdkError::task(format!("unable to create the SDK runtime: {error}")))
    }

    pub(crate) fn enter(&self) -> tokio::runtime::EnterGuard<'_> {
        self.runtime.enter()
    }

    pub(crate) async fn sdk<T, F>(&self, future: F) -> Result<T, SdkError>
    where
        T: Send + 'static,
        F: Future<Output = wasmer_sdk::Result<T>> + Send + 'static,
    {
        self.runtime
            .spawn(future)
            .await
            .map_err(|error| SdkError::task(format!("SDK task failed: {error}")))?
            .map_err(SdkError::from)
    }

    pub(crate) async fn io<T, F>(&self, future: F) -> Result<T, SdkError>
    where
        T: Send + 'static,
        F: Future<Output = std::io::Result<T>> + Send + 'static,
    {
        self.runtime
            .spawn(future)
            .await
            .map_err(|error| SdkError::task(format!("stream task failed: {error}")))?
            .map_err(SdkError::from)
    }
}

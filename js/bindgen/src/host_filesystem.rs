//! Experimental native filesystem transport for worker-based embedders.
//! Only numeric mount/file handles cross workers; no JS values are retained.
use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use wasmer_sdk::{
    DirectoryEntry, File, FileMetadata, FileOpenOptions, FileSystem, FileSystemCapabilities,
    FileType, FsError, FsResult, RelativePath,
};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerHostFileSystem)]
    fn host_call(mount: u32, method: &str, args: JsValue) -> Result<JsValue, JsValue>;
}

// Bound individual messages: large reads and writes are completed by WASIX's
// normal short-read/short-write handling instead of unbounded IPC allocations.
const CHUNK_BYTES: usize = 64 * 1024;

fn call<T: Serialize, R: serde::de::DeserializeOwned>(
    mount: u32,
    method: &str,
    args: T,
) -> FsResult<R> {
    let args = serde_wasm_bindgen::to_value(&args).map_err(|e| FsError::Io(e.to_string()))?;
    let value = host_call(mount, method, args).map_err(|error| {
        let code = js_sys::Reflect::get(&error, &JsValue::from_str("code"))
            .ok()
            .and_then(|v| v.as_string());
        match code.as_deref() {
            Some("ENOENT") => FsError::NotFound,
            Some("EEXIST") => FsError::AlreadyExists,
            Some("EACCES" | "EPERM" | "ELOOP") => FsError::PermissionDenied,
            Some("ENOTDIR") => FsError::NotDirectory,
            Some("EISDIR") => FsError::NotFile,
            Some("ENOTEMPTY") => FsError::DirectoryNotEmpty,
            Some("ENOTSUP") => FsError::Unsupported,
            _ => FsError::Io(format!("native {method}: {error:?}")),
        }
    })?;
    serde_wasm_bindgen::from_value(value).map_err(|e| FsError::Io(e.to_string()))
}

fn path(path: &RelativePath) -> String {
    path.as_path().to_string_lossy().into_owned()
}

#[derive(Deserialize)]
struct Metadata {
    kind: String,
    size: u64,
}
impl From<Metadata> for FileMetadata {
    fn from(value: Metadata) -> Self {
        Self {
            file_type: if value.kind == "directory" {
                FileType::Directory
            } else {
                FileType::File
            },
            len: value.size,
            readonly: false,
        }
    }
}

#[derive(Debug)]
pub(crate) struct HostFileSystem {
    pub(crate) mount_id: u32,
}

#[async_trait]
impl FileSystem for HostFileSystem {
    fn capabilities(&self) -> FileSystemCapabilities {
        FileSystemCapabilities::READ_WRITE
    }

    async fn stat(&self, name: &RelativePath) -> FsResult<FileMetadata> {
        call::<_, Metadata>(self.mount_id, "stat", (path(name),)).map(Into::into)
    }

    async fn read_dir(&self, name: &RelativePath) -> FsResult<Vec<DirectoryEntry>> {
        #[derive(Deserialize)]
        struct Entry {
            name: String,
            kind: String,
            size: u64,
        }
        let entries: Vec<Entry> = call(self.mount_id, "readDir", (path(name),))?;
        Ok(entries
            .into_iter()
            .map(|e| DirectoryEntry {
                name: e.name,
                metadata: Metadata {
                    kind: e.kind,
                    size: e.size,
                }
                .into(),
            })
            .collect())
    }

    async fn open(&self, name: &RelativePath, options: FileOpenOptions) -> FsResult<Arc<dyn File>> {
        let id: u32 = call(
            self.mount_id,
            "open",
            (
                path(name),
                options.read,
                options.write,
                options.create,
                options.create_new,
                options.truncate,
                options.append,
            ),
        )?;
        Ok(Arc::new(HostFile {
            mount_id: self.mount_id,
            id,
        }))
    }

    async fn create_dir(&self, name: &RelativePath) -> FsResult<()> {
        call(self.mount_id, "mkdir", (path(name),))
    }
    async fn remove(&self, name: &RelativePath, recursive: bool) -> FsResult<()> {
        if recursive {
            return Err(FsError::Unsupported);
        }
        call(self.mount_id, "remove", (path(name),))
    }
    async fn rename(&self, from: &RelativePath, to: &RelativePath) -> FsResult<()> {
        call(self.mount_id, "rename", (path(from), path(to)))
    }
    async fn flush(&self) -> FsResult<()> {
        call(self.mount_id, "sync", ())
    }
}

#[derive(Debug)]
struct HostFile {
    mount_id: u32,
    id: u32,
}

#[async_trait]
impl File for HostFile {
    async fn read_at(&self, offset: u64, length: usize) -> FsResult<Bytes> {
        let bytes: Vec<u8> = call(
            self.mount_id,
            "read",
            (self.id, offset, length.min(CHUNK_BYTES)),
        )?;
        Ok(bytes.into())
    }
    async fn write_at(&self, offset: u64, data: Bytes) -> FsResult<usize> {
        call(
            self.mount_id,
            "write",
            (self.id, offset, &data[..data.len().min(CHUNK_BYTES)]),
        )
    }
    async fn set_len(&self, length: u64) -> FsResult<()> {
        call(self.mount_id, "setLen", (self.id, length))
    }
    async fn flush(&self) -> FsResult<()> {
        call(self.mount_id, "flush", (self.id,))
    }
    async fn close(&self) -> FsResult<()> {
        call(self.mount_id, "close", (self.id,))
    }
}

impl Drop for HostFile {
    fn drop(&mut self) {
        // WASIX may drop a descriptor without AsyncWrite::shutdown. Native
        // close is idempotent, and the embedder also closes all handles on teardown.
        let _ = call::<_, ()>(self.mount_id, "close", (self.id,));
    }
}

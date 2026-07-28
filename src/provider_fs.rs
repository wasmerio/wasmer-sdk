use std::{
    fmt::Debug,
    future::Future,
    io::{self, SeekFrom},
    path::{Component, Path, PathBuf},
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll},
};

use async_trait::async_trait;
use bytes::Bytes;
use thiserror::Error;
use virtual_fs::{
    AsyncRead, AsyncReadExt, AsyncSeek, AsyncSeekExt, AsyncWrite, AsyncWriteExt,
    FileOpener as VirtualFileOpener, FileSystem as VirtualFileSystem, OpenOptionsConfig,
    VirtualFile,
};

/// Result type for external filesystem providers.
pub type FsResult<T> = std::result::Result<T, FsError>;

/// Stable errors returned by an SDK filesystem provider.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
#[non_exhaustive]
pub enum FsError {
    #[error("entry not found")]
    NotFound,
    #[error("entry already exists")]
    AlreadyExists,
    #[error("permission denied")]
    PermissionDenied,
    #[error("invalid path or option: {0}")]
    InvalidInput(String),
    #[error("expected a directory")]
    NotDirectory,
    #[error("expected a file")]
    NotFile,
    #[error("directory is not empty")]
    DirectoryNotEmpty,
    #[error("operation is unsupported")]
    Unsupported,
    #[error("filesystem I/O failed: {0}")]
    Io(String),
}

/// A normalized path relative to a provider's mounted root.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct RelativePath(PathBuf);

impl RelativePath {
    /// Parse and validate a provider-relative path.
    ///
    /// # Errors
    ///
    /// Returns an error for absolute paths, host prefixes, or `..`.
    pub fn new(path: impl AsRef<Path>) -> FsResult<Self> {
        let path = path.as_ref();
        if path.is_absolute() {
            return Err(FsError::InvalidInput(
                "provider paths must be relative".to_owned(),
            ));
        }
        let mut normalized = PathBuf::new();
        for component in path.components() {
            match component {
                Component::Normal(value) => normalized.push(value),
                Component::CurDir => {}
                Component::ParentDir | Component::Prefix(_) | Component::RootDir => {
                    return Err(FsError::InvalidInput(
                        "provider paths cannot escape their root".to_owned(),
                    ));
                }
            }
        }
        Ok(Self(normalized))
    }

    #[must_use]
    pub fn as_path(&self) -> &Path {
        &self.0
    }

    #[must_use]
    pub fn is_root(&self) -> bool {
        self.0.as_os_str().is_empty()
    }
}

/// The kind of an external filesystem entry.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FileType {
    File,
    Directory,
}

/// Metadata returned by an external filesystem provider.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FileMetadata {
    pub file_type: FileType,
    pub len: u64,
    pub readonly: bool,
}

/// One immediate child returned by [`FileSystem::read_dir`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirectoryEntry {
    pub name: String,
    pub metadata: FileMetadata,
}

/// Provider-declared capabilities.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FileSystemCapabilities {
    pub read: bool,
    pub write: bool,
}

impl FileSystemCapabilities {
    pub const READ_ONLY: Self = Self {
        read: true,
        write: false,
    };
    pub const READ_WRITE: Self = Self {
        read: true,
        write: true,
    };
}

/// Options used when opening a provider file.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
#[allow(clippy::struct_excessive_bools)]
pub struct FileOpenOptions {
    pub read: bool,
    pub write: bool,
    pub create: bool,
    pub create_new: bool,
    pub truncate: bool,
    pub append: bool,
}

/// An asynchronously accessed file supplied by an external provider.
#[async_trait]
pub trait File: Debug + Send + Sync + 'static {
    async fn read_at(&self, offset: u64, length: usize) -> FsResult<Bytes>;
    async fn write_at(&self, offset: u64, data: Bytes) -> FsResult<usize>;
    async fn set_len(&self, length: u64) -> FsResult<()>;
    async fn flush(&self) -> FsResult<()>;
    async fn close(&self) -> FsResult<()>;
}

/// Object-safe asynchronous filesystem provider mounted beneath a guest path.
#[async_trait]
pub trait FileSystem: Debug + Send + Sync + 'static {
    fn capabilities(&self) -> FileSystemCapabilities;
    async fn stat(&self, path: &RelativePath) -> FsResult<FileMetadata>;
    async fn read_dir(&self, path: &RelativePath) -> FsResult<Vec<DirectoryEntry>>;
    async fn open(&self, path: &RelativePath, options: FileOpenOptions) -> FsResult<Arc<dyn File>>;
    async fn create_dir(&self, path: &RelativePath) -> FsResult<()>;
    async fn remove(&self, path: &RelativePath, recursive: bool) -> FsResult<()>;
    async fn rename(&self, from: &RelativePath, to: &RelativePath) -> FsResult<()>;
    async fn flush(&self) -> FsResult<()>;
}

/// Guest rights applied on top of provider capabilities.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MountMode {
    ReadOnly,
    ReadWrite,
}

/// A portable, mutable in-memory external filesystem provider.
#[derive(Clone, Debug, Default)]
pub struct Directory {
    inner: virtual_fs::mem_fs::FileSystem,
}

impl Directory {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Write a complete file relative to the directory root.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid paths or failed filesystem operations.
    pub async fn write(&self, path: impl AsRef<Path>, bytes: impl Into<Bytes>) -> FsResult<()> {
        let path = RelativePath::new(path)?;
        if let Some(parent) = internal_path(&path).parent() {
            virtual_fs::create_dir_all(&self.inner, parent).map_err(map_virtual_error)?;
        }
        let file = self
            .open(
                &path,
                FileOpenOptions {
                    write: true,
                    create: true,
                    truncate: true,
                    ..FileOpenOptions::default()
                },
            )
            .await?;
        file.write_at(0, bytes.into()).await?;
        file.flush().await
    }

    /// Write UTF-8 text relative to the directory root.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid paths or failed filesystem operations.
    pub async fn write_text(
        &self,
        path: impl AsRef<Path>,
        text: impl Into<String>,
    ) -> FsResult<()> {
        self.write(path, Bytes::from(text.into())).await
    }

    /// Read a complete file relative to the directory root.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid paths or failed filesystem operations.
    pub async fn read(&self, path: impl AsRef<Path>) -> FsResult<Bytes> {
        let path = RelativePath::new(path)?;
        let metadata = self.stat(&path).await?;
        let length = usize::try_from(metadata.len)
            .map_err(|_| FsError::Io("file is too large for this target".to_owned()))?;
        self.open(
            &path,
            FileOpenOptions {
                read: true,
                ..FileOpenOptions::default()
            },
        )
        .await?
        .read_at(0, length)
        .await
    }

    /// Read and decode UTF-8 text.
    ///
    /// # Errors
    ///
    /// Returns an error for filesystem failures or invalid UTF-8.
    pub async fn read_text(&self, path: impl AsRef<Path>) -> FsResult<String> {
        String::from_utf8(self.read(path).await?.to_vec())
            .map_err(|error| FsError::Io(error.to_string()))
    }
}

#[async_trait]
impl FileSystem for Directory {
    fn capabilities(&self) -> FileSystemCapabilities {
        FileSystemCapabilities::READ_WRITE
    }

    async fn stat(&self, path: &RelativePath) -> FsResult<FileMetadata> {
        let metadata = self
            .inner
            .metadata(&internal_path(path))
            .map_err(map_virtual_error)?;
        Ok(FileMetadata {
            file_type: if metadata.is_dir() {
                FileType::Directory
            } else {
                FileType::File
            },
            len: metadata.len(),
            readonly: false,
        })
    }

    async fn read_dir(&self, path: &RelativePath) -> FsResult<Vec<DirectoryEntry>> {
        self.inner
            .read_dir(&internal_path(path))
            .map_err(map_virtual_error)?
            .map(|entry| {
                let entry = entry.map_err(map_virtual_error)?;
                let metadata = entry.metadata().map_err(map_virtual_error)?;
                Ok(DirectoryEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    metadata: FileMetadata {
                        file_type: if metadata.is_dir() {
                            FileType::Directory
                        } else {
                            FileType::File
                        },
                        len: metadata.len(),
                        readonly: false,
                    },
                })
            })
            .collect()
    }

    async fn open(&self, path: &RelativePath, options: FileOpenOptions) -> FsResult<Arc<dyn File>> {
        let mut builder = self.inner.new_open_options();
        builder
            .read(options.read)
            .write(options.write)
            .create(options.create)
            .create_new(options.create_new)
            .truncate(options.truncate)
            .append(options.append);
        let file = builder
            .open(internal_path(path))
            .map_err(map_virtual_error)?;
        Ok(Arc::new(DirectoryFile {
            inner: tokio::sync::Mutex::new(file),
            closed: AtomicBool::new(false),
        }))
    }

    async fn create_dir(&self, path: &RelativePath) -> FsResult<()> {
        self.inner
            .create_dir(&internal_path(path))
            .map_err(map_virtual_error)
    }

    async fn remove(&self, path: &RelativePath, recursive: bool) -> FsResult<()> {
        let internal = internal_path(path);
        let metadata = self.inner.metadata(&internal).map_err(map_virtual_error)?;
        if metadata.is_file() {
            return self.inner.remove_file(&internal).map_err(map_virtual_error);
        }
        if recursive {
            remove_directory_tree(&self.inner, &internal)?;
        }
        self.inner.remove_dir(&internal).map_err(map_virtual_error)
    }

    async fn rename(&self, from: &RelativePath, to: &RelativePath) -> FsResult<()> {
        self.inner
            .rename(&internal_path(from), &internal_path(to))
            .await
            .map_err(map_virtual_error)
    }

    async fn flush(&self) -> FsResult<()> {
        Ok(())
    }
}

#[derive(Debug)]
struct DirectoryFile {
    inner: tokio::sync::Mutex<Box<dyn VirtualFile + Send + Sync>>,
    closed: AtomicBool,
}

#[async_trait]
impl File for DirectoryFile {
    async fn read_at(&self, offset: u64, length: usize) -> FsResult<Bytes> {
        self.ensure_open()?;
        let mut file = self.inner.lock().await;
        file.seek(SeekFrom::Start(offset))
            .await
            .map_err(|error| FsError::Io(error.to_string()))?;
        let mut bytes = vec![0; length];
        let read = file
            .read(&mut bytes)
            .await
            .map_err(|error| FsError::Io(error.to_string()))?;
        bytes.truncate(read);
        Ok(bytes.into())
    }

    async fn write_at(&self, offset: u64, data: Bytes) -> FsResult<usize> {
        self.ensure_open()?;
        let mut file = self.inner.lock().await;
        file.seek(SeekFrom::Start(offset))
            .await
            .map_err(|error| FsError::Io(error.to_string()))?;
        file.write(&data)
            .await
            .map_err(|error| FsError::Io(error.to_string()))
    }

    async fn set_len(&self, length: u64) -> FsResult<()> {
        self.ensure_open()?;
        self.inner
            .lock()
            .await
            .set_len(length)
            .map_err(map_virtual_error)
    }

    async fn flush(&self) -> FsResult<()> {
        self.ensure_open()?;
        self.inner
            .lock()
            .await
            .flush()
            .await
            .map_err(|error| FsError::Io(error.to_string()))
    }

    async fn close(&self) -> FsResult<()> {
        self.closed.store(true, Ordering::Release);
        Ok(())
    }
}

impl DirectoryFile {
    fn ensure_open(&self) -> FsResult<()> {
        if self.closed.load(Ordering::Acquire) {
            Err(FsError::Io("file is closed".to_owned()))
        } else {
            Ok(())
        }
    }
}

fn internal_path(path: &RelativePath) -> PathBuf {
    Path::new("/").join(path.as_path())
}

fn remove_directory_tree(filesystem: &virtual_fs::mem_fs::FileSystem, path: &Path) -> FsResult<()> {
    let entries: Vec<_> = filesystem
        .read_dir(path)
        .map_err(map_virtual_error)?
        .collect::<virtual_fs::Result<Vec<_>>>()
        .map_err(map_virtual_error)?;
    for entry in entries {
        let child = entry.path();
        if entry.metadata().map_err(map_virtual_error)?.is_dir() {
            remove_directory_tree(filesystem, &child)?;
            filesystem.remove_dir(&child).map_err(map_virtual_error)?;
        } else {
            filesystem.remove_file(&child).map_err(map_virtual_error)?;
        }
    }
    Ok(())
}

#[derive(Debug)]
pub(crate) struct ProviderAdapter {
    provider: Arc<dyn FileSystem>,
    mode: MountMode,
    runtime: tokio::runtime::Handle,
}

impl ProviderAdapter {
    pub(crate) fn new(
        provider: Arc<dyn FileSystem>,
        mode: MountMode,
        runtime: tokio::runtime::Handle,
    ) -> Self {
        Self {
            provider,
            mode,
            runtime,
        }
    }

    fn path(path: &Path) -> virtual_fs::Result<RelativePath> {
        let relative = path.strip_prefix("/").unwrap_or(path);
        RelativePath::new(relative).map_err(map_provider_error)
    }

    fn writable(&self) -> bool {
        self.mode == MountMode::ReadWrite && self.provider.capabilities().write
    }

    fn readable(&self) -> bool {
        self.provider.capabilities().read
    }
}

impl VirtualFileOpener for ProviderAdapter {
    fn open(
        &self,
        path: &Path,
        config: &OpenOptionsConfig,
    ) -> virtual_fs::Result<Box<dyn VirtualFile + Send + Sync + 'static>> {
        let path = Self::path(path)?;
        let writes =
            config.write || config.append || config.create || config.create_new || config.truncate;
        if config.read && !self.readable() {
            return Err(virtual_fs::FsError::PermissionDenied);
        }
        if writes && !self.writable() {
            return Err(virtual_fs::FsError::PermissionDenied);
        }
        let options = FileOpenOptions {
            read: config.read,
            write: config.write,
            create: config.create,
            create_new: config.create_new,
            truncate: config.truncate,
            append: config.append,
        };
        let initial_len = if config.append {
            let provider = Arc::clone(&self.provider);
            let stat_path = path.clone();
            run_provider(
                &self.runtime,
                async move { provider.stat(&stat_path).await },
            )
            .map_or(0, |metadata| metadata.len)
        } else {
            0
        };
        let provider = Arc::clone(&self.provider);
        let file = run_provider(
            &self.runtime,
            async move { provider.open(&path, options).await },
        )
        .map_err(map_provider_error)?;
        Ok(Box::new(ProviderFile {
            file,
            runtime: self.runtime.clone(),
            cursor: initial_len,
            len: initial_len,
            writable: self.writable(),
            closed: false,
        }))
    }
}

impl VirtualFileSystem for ProviderAdapter {
    fn readlink(&self, _path: &Path) -> virtual_fs::Result<PathBuf> {
        Err(virtual_fs::FsError::Unsupported)
    }

    fn read_dir(&self, path: &Path) -> virtual_fs::Result<virtual_fs::ReadDir> {
        if !self.readable() {
            return Err(virtual_fs::FsError::PermissionDenied);
        }
        let provider_path = Self::path(path)?;
        let provider = Arc::clone(&self.provider);
        let entries = run_provider(&self.runtime, async move {
            provider.read_dir(&provider_path).await
        })
        .map_err(map_provider_error)?
        .into_iter()
        .map(|entry| virtual_fs::DirEntry {
            path: path.join(entry.name),
            metadata: Ok(to_virtual_metadata(entry.metadata)),
        })
        .collect();
        Ok(virtual_fs::ReadDir::new(entries))
    }

    fn create_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        if !self.writable() {
            return Err(virtual_fs::FsError::PermissionDenied);
        }
        let provider_path = Self::path(path)?;
        let provider = Arc::clone(&self.provider);
        run_provider(&self.runtime, async move {
            provider.create_dir(&provider_path).await
        })
        .map_err(map_provider_error)
    }

    fn remove_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        if !self.writable() {
            return Err(virtual_fs::FsError::PermissionDenied);
        }
        let provider_path = Self::path(path)?;
        let provider = Arc::clone(&self.provider);
        run_provider(&self.runtime, async move {
            provider.remove(&provider_path, false).await
        })
        .map_err(map_provider_error)
    }

    fn rename<'a>(
        &'a self,
        from: &'a Path,
        to: &'a Path,
    ) -> futures::future::BoxFuture<'a, virtual_fs::Result<()>> {
        Box::pin(async move {
            if !self.writable() {
                return Err(virtual_fs::FsError::PermissionDenied);
            }
            self.provider
                .rename(&Self::path(from)?, &Self::path(to)?)
                .await
                .map_err(map_provider_error)
        })
    }

    fn metadata(&self, path: &Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        if !self.readable() {
            return Err(virtual_fs::FsError::PermissionDenied);
        }
        let provider_path = Self::path(path)?;
        let provider = Arc::clone(&self.provider);
        run_provider(
            &self.runtime,
            async move { provider.stat(&provider_path).await },
        )
        .map(to_virtual_metadata)
        .map_err(map_provider_error)
    }

    fn symlink_metadata(&self, path: &Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        self.metadata(path)
    }

    fn remove_file(&self, path: &Path) -> virtual_fs::Result<()> {
        if !self.writable() {
            return Err(virtual_fs::FsError::PermissionDenied);
        }
        let provider_path = Self::path(path)?;
        let provider = Arc::clone(&self.provider);
        run_provider(&self.runtime, async move {
            provider.remove(&provider_path, false).await
        })
        .map_err(map_provider_error)
    }

    fn new_open_options(&self) -> virtual_fs::OpenOptions<'_> {
        virtual_fs::OpenOptions::new(self)
    }
}

#[derive(Debug)]
struct ProviderFile {
    file: Arc<dyn File>,
    runtime: tokio::runtime::Handle,
    cursor: u64,
    len: u64,
    writable: bool,
    closed: bool,
}

impl AsyncRead for ProviderFile {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.closed {
            return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
        }
        let file = Arc::clone(&self.file);
        let offset = self.cursor;
        let length = buffer.remaining();
        let bytes = match run_provider(
            &self.runtime,
            async move { file.read_at(offset, length).await },
        ) {
            Ok(bytes) => bytes,
            Err(error) => return Poll::Ready(Err(provider_io_error(error))),
        };
        let amount = bytes.len().min(buffer.remaining());
        buffer.put_slice(&bytes[..amount]);
        self.cursor = self.cursor.saturating_add(amount as u64);
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for ProviderFile {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.closed {
            return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
        }
        if !self.writable {
            return Poll::Ready(Err(io::ErrorKind::PermissionDenied.into()));
        }
        let file = Arc::clone(&self.file);
        let offset = self.cursor;
        let data = Bytes::copy_from_slice(bytes);
        let written = match run_provider(
            &self.runtime,
            async move { file.write_at(offset, data).await },
        ) {
            Ok(written) => written,
            Err(error) => return Poll::Ready(Err(provider_io_error(error))),
        };
        if written > bytes.len() {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "provider reported writing more bytes than supplied",
            )));
        }
        self.cursor = self.cursor.saturating_add(written as u64);
        self.len = self.len.max(self.cursor);
        Poll::Ready(Ok(written))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let file = Arc::clone(&self.file);
        Poll::Ready(
            run_provider(&self.runtime, async move { file.flush().await })
                .map_err(provider_io_error),
        )
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let file = Arc::clone(&self.file);
        let result = run_provider(&self.runtime, async move { file.close().await })
            .map_err(provider_io_error);
        self.closed = true;
        Poll::Ready(result)
    }
}

impl AsyncSeek for ProviderFile {
    fn start_seek(mut self: Pin<&mut Self>, position: SeekFrom) -> io::Result<()> {
        let next = match position {
            SeekFrom::Start(offset) => i128::from(offset),
            SeekFrom::End(offset) => i128::from(self.len) + i128::from(offset),
            SeekFrom::Current(offset) => i128::from(self.cursor) + i128::from(offset),
        };
        self.cursor = u64::try_from(next)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid seek"))?;
        Ok(())
    }

    fn poll_complete(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(self.cursor))
    }
}

impl VirtualFile for ProviderFile {
    fn last_accessed(&self) -> u64 {
        0
    }

    fn last_modified(&self) -> u64 {
        0
    }

    fn created_time(&self) -> u64 {
        0
    }

    fn size(&self) -> u64 {
        self.len
    }

    fn set_len(&mut self, length: u64) -> virtual_fs::Result<()> {
        if !self.writable {
            return Err(virtual_fs::FsError::PermissionDenied);
        }
        let file = Arc::clone(&self.file);
        run_provider(&self.runtime, async move { file.set_len(length).await })
            .map_err(map_provider_error)?;
        self.len = length;
        Ok(())
    }

    fn unlink(&mut self) -> virtual_fs::Result<()> {
        Ok(())
    }

    fn poll_read_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        let available = usize::try_from(self.len.saturating_sub(self.cursor)).unwrap_or(usize::MAX);
        Poll::Ready(Ok(available))
    }

    fn poll_write_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(8192))
    }
}

fn to_virtual_metadata(metadata: FileMetadata) -> virtual_fs::Metadata {
    virtual_fs::Metadata {
        ft: match metadata.file_type {
            FileType::File => virtual_fs::FileType::new_file(),
            FileType::Directory => virtual_fs::FileType::new_dir(),
        },
        accessed: 0,
        created: 0,
        modified: 0,
        len: metadata.len,
    }
}

fn map_virtual_error(error: virtual_fs::FsError) -> FsError {
    match error {
        virtual_fs::FsError::EntryNotFound => FsError::NotFound,
        virtual_fs::FsError::AlreadyExists => FsError::AlreadyExists,
        virtual_fs::FsError::PermissionDenied => FsError::PermissionDenied,
        virtual_fs::FsError::BaseNotDirectory => FsError::NotDirectory,
        virtual_fs::FsError::NotAFile => FsError::NotFile,
        virtual_fs::FsError::DirectoryNotEmpty => FsError::DirectoryNotEmpty,
        virtual_fs::FsError::InvalidInput => FsError::InvalidInput(error.to_string()),
        virtual_fs::FsError::Unsupported => FsError::Unsupported,
        _ => FsError::Io(error.to_string()),
    }
}

#[allow(clippy::needless_pass_by_value)]
fn map_provider_error(error: FsError) -> virtual_fs::FsError {
    match error {
        FsError::NotFound => virtual_fs::FsError::EntryNotFound,
        FsError::AlreadyExists => virtual_fs::FsError::AlreadyExists,
        FsError::PermissionDenied => virtual_fs::FsError::PermissionDenied,
        FsError::InvalidInput(_) => virtual_fs::FsError::InvalidInput,
        FsError::NotDirectory => virtual_fs::FsError::BaseNotDirectory,
        FsError::NotFile => virtual_fs::FsError::NotAFile,
        FsError::DirectoryNotEmpty => virtual_fs::FsError::DirectoryNotEmpty,
        FsError::Unsupported => virtual_fs::FsError::Unsupported,
        FsError::Io(_) => virtual_fs::FsError::IOError,
    }
}

fn provider_io_error(error: FsError) -> io::Error {
    io::Error::from(map_provider_error(error))
}

fn run_provider<T, F>(runtime: &tokio::runtime::Handle, future: F) -> T
where
    T: Send + 'static,
    F: Future<Output = T> + Send + 'static,
{
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    runtime.spawn(async move {
        let output = future.await;
        let _ = sender.send(output);
    });
    receiver
        .recv()
        .expect("the provider runtime stopped before completing an operation")
}

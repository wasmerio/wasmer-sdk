use std::path::{Component, Path, PathBuf};

use virtual_fs::{AsyncReadExt, AsyncWriteExt, FileSystem as VirtualFileSystem};

use crate::{
    DirectoryEntry, Error, FileMetadata, FileType, Result, provider_fs::remove_directory_tree,
};

/// Filesystem access to a sandbox's persistent `/workspace`.
#[derive(Clone, Debug)]
pub struct SandboxFileSystem {
    pub(crate) inner: virtual_fs::mem_fs::FileSystem,
}

impl SandboxFileSystem {
    pub(crate) fn new(inner: virtual_fs::mem_fs::FileSystem) -> Self {
        Self { inner }
    }

    /// Write bytes, creating parent directories as needed.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid guest path or a failed filesystem
    /// operation.
    pub async fn write(&self, path: impl AsRef<Path>, bytes: impl AsRef<[u8]>) -> Result<()> {
        let (guest, internal) = workspace_path(path.as_ref())?;
        if let Some(parent) = internal.parent() {
            virtual_fs::create_dir_all(&self.inner, parent).map_err(|error| Error::FileSystem {
                operation: "create_dir_all",
                path: guest.clone(),
                message: error.to_string(),
            })?;
        }
        let mut file = self
            .inner
            .new_open_options()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&internal)
            .map_err(|error| Error::FileSystem {
                operation: "open",
                path: guest.clone(),
                message: error.to_string(),
            })?;
        file.write_all(bytes.as_ref())
            .await
            .map_err(|error| Error::FileSystem {
                operation: "write",
                path: guest.clone(),
                message: error.to_string(),
            })?;
        file.flush().await.map_err(|error| Error::FileSystem {
            operation: "flush",
            path: guest,
            message: error.to_string(),
        })
    }

    /// Write UTF-8 text.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid guest path or a failed filesystem
    /// operation.
    pub async fn write_text(&self, path: impl AsRef<Path>, text: impl AsRef<str>) -> Result<()> {
        self.write(path, text.as_ref().as_bytes()).await
    }

    /// Read a file in full.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid guest path or a failed filesystem
    /// operation.
    pub async fn read(&self, path: impl AsRef<Path>) -> Result<Vec<u8>> {
        let (guest, internal) = workspace_path(path.as_ref())?;
        let mut file = self
            .inner
            .new_open_options()
            .read(true)
            .open(&internal)
            .map_err(|error| Error::FileSystem {
                operation: "open",
                path: guest.clone(),
                message: error.to_string(),
            })?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .await
            .map_err(|error| Error::FileSystem {
                operation: "read",
                path: guest,
                message: error.to_string(),
            })?;
        Ok(bytes)
    }

    /// Read and decode a UTF-8 text file.
    ///
    /// # Errors
    ///
    /// Returns an error for a filesystem failure or invalid UTF-8.
    pub async fn read_text(&self, path: impl AsRef<Path>) -> Result<String> {
        Ok(String::from_utf8(self.read(path).await?)?)
    }

    /// Create a directory and any missing parents.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid guest path or a failed filesystem
    /// operation.
    pub fn create_dir_all(&self, path: impl AsRef<Path>) -> Result<()> {
        let (guest, internal) = workspace_path(path.as_ref())?;
        virtual_fs::create_dir_all(&self.inner, internal).map_err(|error| Error::FileSystem {
            operation: "create_dir_all",
            path: guest,
            message: error.to_string(),
        })
    }

    /// Create one directory. The parent must already exist.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid guest path, a missing parent, or a
    /// failed filesystem operation.
    pub fn create_dir(&self, path: impl AsRef<Path>) -> Result<()> {
        let (guest, internal) = workspace_path(path.as_ref())?;
        self.inner
            .create_dir(&internal)
            .map_err(|error| Error::FileSystem {
                operation: "create_dir",
                path: guest,
                message: error.to_string(),
            })
    }

    /// List the immediate children of a directory.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid guest path or a failed filesystem
    /// operation.
    pub fn read_dir(&self, path: impl AsRef<Path>) -> Result<Vec<DirectoryEntry>> {
        let (guest, internal) = workspace_path(path.as_ref())?;
        self.inner
            .read_dir(&internal)
            .map_err(|error| Error::FileSystem {
                operation: "read_dir",
                path: guest.clone(),
                message: error.to_string(),
            })?
            .map(|entry| {
                let entry = entry.map_err(|error| Error::FileSystem {
                    operation: "read_dir",
                    path: guest.clone(),
                    message: error.to_string(),
                })?;
                let metadata = entry.metadata().map_err(|error| Error::FileSystem {
                    operation: "read_dir",
                    path: guest.clone(),
                    message: error.to_string(),
                })?;
                Ok(DirectoryEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    metadata: virtual_metadata(&metadata),
                })
            })
            .collect()
    }

    /// Return metadata for one path.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid guest path, a missing entry, or a
    /// failed filesystem operation.
    pub fn stat(&self, path: impl AsRef<Path>) -> Result<FileMetadata> {
        let (guest, internal) = workspace_path(path.as_ref())?;
        let metadata = self
            .inner
            .metadata(&internal)
            .map_err(|error| Error::FileSystem {
                operation: "stat",
                path: guest,
                message: error.to_string(),
            })?;
        Ok(virtual_metadata(&metadata))
    }

    /// Remove a file, or a directory when `recursive` is requested or it is
    /// empty.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid guest path, a missing entry, or a
    /// failed filesystem operation.
    pub fn remove(&self, path: impl AsRef<Path>, recursive: bool) -> Result<()> {
        let (guest, internal) = workspace_path(path.as_ref())?;
        let map_error = |operation: &'static str| {
            let guest = guest.clone();
            move |error: virtual_fs::FsError| Error::FileSystem {
                operation,
                path: guest.clone(),
                message: error.to_string(),
            }
        };
        let metadata = self.inner.metadata(&internal).map_err(map_error("stat"))?;
        if metadata.is_file() {
            return self
                .inner
                .remove_file(&internal)
                .map_err(map_error("remove"));
        }
        if recursive {
            remove_directory_tree(&self.inner, &internal).map_err(|error| Error::FileSystem {
                operation: "remove",
                path: guest.clone(),
                message: error.to_string(),
            })?;
        }
        self.inner
            .remove_dir(&internal)
            .map_err(map_error("remove"))
    }

    /// Rename a file or directory within the workspace.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid guest path or a failed filesystem
    /// operation.
    pub async fn rename(&self, from: impl AsRef<Path>, to: impl AsRef<Path>) -> Result<()> {
        let (guest_from, internal_from) = workspace_path(from.as_ref())?;
        let (_, internal_to) = workspace_path(to.as_ref())?;
        self.inner
            .rename(&internal_from, &internal_to)
            .await
            .map_err(|error| Error::FileSystem {
                operation: "rename",
                path: guest_from,
                message: error.to_string(),
            })
    }
}

fn virtual_metadata(metadata: &virtual_fs::Metadata) -> FileMetadata {
    FileMetadata {
        file_type: if metadata.is_dir() {
            FileType::Directory
        } else {
            FileType::File
        },
        len: metadata.len(),
        readonly: false,
    }
}

pub(crate) fn validate_guest_path(path: &Path) -> Result<PathBuf> {
    if path.as_os_str().is_empty() {
        return Err(Error::InvalidGuestPath {
            path: path.to_owned(),
            message: "path must not be empty".to_owned(),
        });
    }
    for component in path.components() {
        if matches!(component, Component::ParentDir | Component::Prefix(_)) {
            return Err(Error::InvalidGuestPath {
                path: path.to_owned(),
                message: "path traversal and host prefixes are not allowed".to_owned(),
            });
        }
    }
    Ok(path.to_owned())
}

fn workspace_path(path: &Path) -> Result<(PathBuf, PathBuf)> {
    let path = validate_guest_path(path)?;
    let relative = if path.is_absolute() {
        path.strip_prefix("/workspace")
            .map_err(|_| Error::InvalidGuestPath {
                path: path.clone(),
                message: "sandbox filesystem paths must be inside `/workspace`".to_owned(),
            })?
    } else {
        path.as_path()
    };
    let internal = Path::new("/").join(relative);
    Ok((Path::new("/workspace").join(relative), internal))
}

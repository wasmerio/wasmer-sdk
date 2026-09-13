"""Recognize WASIX wheel extensions until Python's built-in suffixes agree."""

import sys
from importlib.machinery import (
    BYTECODE_SUFFIXES,
    EXTENSION_SUFFIXES,
    SOURCE_SUFFIXES,
    ExtensionFileLoader,
    FileFinder,
    SourceFileLoader,
    SourcelessFileLoader,
)


def _register_wasix_extensions():
    # Derive aliases from this interpreter's ABI, never accept arbitrary CPython
    # versions or architectures. Keep native suffixes first when both exist.
    aliases = [
        suffix.removesuffix("-wasi.so") + "-wasi-threads.so"
        for suffix in EXTENSION_SUFFIXES
        if suffix.endswith("-wasm32-wasi.so")
    ]
    aliases = [suffix for suffix in aliases if suffix not in EXTENSION_SUFFIXES]
    if not aliases:
        return

    EXTENSION_SUFFIXES.extend(aliases)
    sys.path_hooks.insert(0, FileFinder.path_hook(
        (ExtensionFileLoader, EXTENSION_SUFFIXES),
        (SourceFileLoader, SOURCE_SUFFIXES),
        (SourcelessFileLoader, BYTECODE_SUFFIXES),
    ))
    # FileFinder snapshots suffixes at creation, including during startup.
    # Preserve other importers (e.g. zipimport) while refreshing file finders.
    for path, finder in list(sys.path_importer_cache.items()):
        if isinstance(finder, FileFinder):
            del sys.path_importer_cache[path]


_register_wasix_extensions()

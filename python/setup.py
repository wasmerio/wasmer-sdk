from __future__ import annotations

import platform
import sys

from setuptools import Distribution, setup
from setuptools.command.bdist_wheel import bdist_wheel


class NativeDistribution(Distribution):
    """Mark the ctypes-backed package as platform-specific."""

    def has_ext_modules(self) -> bool:
        return True

    def is_pure(self) -> bool:
        return False


class NativeWheel(bdist_wheel):
    """The UniFFI library is native, but independent of the CPython ABI."""

    def finalize_options(self) -> None:
        super().finalize_options()
        self.root_is_pure = False

    def get_tag(self) -> tuple[str, str, str]:
        _, _, platform_tag = super().get_tag()
        if sys.platform == "darwin" and platform_tag.endswith("_universal2"):
            platform_tag = platform_tag.removesuffix("universal2") + platform.machine()
        return "py3", "none", platform_tag


setup(
    distclass=NativeDistribution,
    cmdclass={"bdist_wheel": NativeWheel},
)

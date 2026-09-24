#!/usr/bin/env bash
set -euo pipefail
# PostgreSQL 18.4 sources: https://ftp.postgresql.org/pub/source/v18.4/
# postgresql-18.4.tar.bz2 SHA-256:
# 81a81ec695fb0c7901407defaa1d2f7973617154cf27ba74e3a7ab8e64436094
package_dir=$(cd "$(dirname "$0")" && pwd)
source_dir=$(cd "${1:?Usage: build.sh /path/to/postgresql-18.4}" && pwd)
build_dir="$package_dir/.build"
mkdir -p "$build_dir"
cd "$build_dir"
export CC=${CC:-wasixcc}
export AR=${AR:-wasixar}
export RANLIB=${RANLIB:-wasixranlib}
export CFLAGS="-O2 -g0 -sWASM_EXCEPTIONS=exnref -sRUN_WASM_OPT=no -mno-wide-arithmetic -include $package_dir/wasix-compat.h"
export LDFLAGS="-sWASM_EXCEPTIONS=exnref -sRUN_WASM_OPT=no"
"$source_dir/configure" --host=wasm32-unknown-wasix --with-template=linux \
  --without-readline --without-zlib --without-icu --without-openssl \
  --without-libxml --without-lz4 --without-zstd --disable-nls --disable-rpath \
  --with-system-tzdata=/usr/share/zoneinfo
# libpq's normal target also builds a Linux shared object. Only the static
# library is needed, along with libpgcommon_shlib's public encoding symbols.
python3 - <<'PY'
from pathlib import Path
p = Path('src/Makefile.global')
p.write_text(p.read_text().replace('$(MAKE) -C $(libpq_builddir) all',
                                 '$(MAKE) -C $(libpq_builddir) all-static-lib'))
PY
# Generate shared prerequisites before compiling in parallel: recursive PG
# submakes otherwise race when generating headers such as pg_config_paths.h.
make -C src/backend generated-headers
make -C src/port all
make -C src/common all
make -C src/fe_utils all
make -C src/interfaces/libpq all-static-lib
make -C src/bin/psql -j"${JOBS:-4}" LDFLAGS_EX=-lpgcommon_shlib
cp src/bin/psql/psql "$package_dir/psql.wasm"
wasm-tools validate --features=-legacy-exceptions,-wide-arithmetic "$package_dir/psql.wasm"
wasmer package build --check "$package_dir"

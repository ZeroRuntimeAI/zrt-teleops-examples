#!/bin/sh
# Copies the @zeroruntime/teleops-wasm tarball into studio/vendor/ so `docker build studio` can see it.
# Temporary: package.json points at a local `npm pack` tarball outside this repo until the package is
# published to npm; once it is, delete this script, studio/vendor/ and the sed line in the Dockerfile.
#
#   scripts/vendor-wasm.sh [path/to/zeroruntime-teleops-wasm-<version>.tgz]
#
# With no argument it uses the path package.json already names.
set -eu
cd "$(dirname "$0")/.."
src="${1:-}"
if [ -z "$src" ]; then
  src=$(sed -n 's|.*"@zeroruntime/teleops-wasm": "file:\(.*\)".*|\1|p' package.json)
fi
[ -f "$src" ] || { echo "tarball not found: $src" >&2; exit 1; }
mkdir -p vendor
cp "$src" vendor/
echo "vendored $(basename "$src") into studio/vendor/"

#!/bin/sh
# Builds glass-arm64.node and glass-x86_64.node, needs the Xcode command line tools and node's headers
set -e
cd "$(dirname "$0")"
INC="$(dirname "$(command -v node)")/../include/node"
for arch in arm64 x86_64; do
  clang++ -std=c++17 -fobjc-arc -ObjC++ -bundle -undefined dynamic_lookup \
    -arch $arch -mmacosx-version-min=11.0 -DNODE_GYP_MODULE_NAME=glass -DNAPI_VERSION=8 \
    -I"$INC" glass.mm -framework AppKit -framework QuartzCore -o "glass-$arch.node"
done

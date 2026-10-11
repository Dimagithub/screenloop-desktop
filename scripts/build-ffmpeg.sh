#!/usr/bin/env bash
# Builds a minimal, LGPL-only static ffmpeg (VideoToolbox H.264 + libopus + avfoundation) for macOS.
# Usage: scripts/build-ffmpeg.sh <arm64|x86_64> <outfile>
set -euo pipefail
ARCH=$1; OUT=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
FFMPEG_VER=7.1.1; FFMPEG_SHA=733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1
OPUS_VER=1.5.2;   OPUS_SHA=65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1
W=$(mktemp -d); P=$W/prefix; cd "$W"
fetch() { curl -fsSL -o "$1" "$2"; echo "$3  $1" | shasum -a 256 -c -; }
fetch opus.tgz "https://downloads.xiph.org/releases/opus/opus-$OPUS_VER.tar.gz" $OPUS_SHA
fetch ff.tar.xz "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VER.tar.xz" $FFMPEG_SHA
tar xzf opus.tgz && tar xJf ff.tar.xz
CF="-arch $ARCH -mmacosx-version-min=11.0"
(cd opus-$OPUS_VER && CFLAGS="$CF" ./configure --prefix="$P" --disable-shared --enable-static --disable-doc --disable-extra-programs \
  --host=$ARCH-apple-darwin && make -j4 && make install)
cd ffmpeg-$FFMPEG_VER
PKG_CONFIG_PATH="$P/lib/pkgconfig" ./configure --prefix="$P" --arch=$ARCH --enable-cross-compile --cc="clang -arch $ARCH" \
  --extra-cflags="$CF" --extra-ldflags="$CF" \
  --disable-gpl --disable-nonfree --disable-version3 --disable-shared --enable-static \
  --disable-autodetect --enable-libopus --enable-videotoolbox --enable-audiotoolbox --enable-avfoundation \
  --enable-indev=avfoundation --disable-doc --disable-ffplay --disable-ffprobe --disable-network --disable-debug \
  --pkg-config-flags=--static
make -j4 && strip ffmpeg && cp ffmpeg "$OUT"
# Guard: LGPL-only and no non-system dynamic libs.
if otool -L "$OUT" | tail -n +2 | grep -vE '^\s*/(System|usr/lib)/'; then echo "non-system dylib linked" >&2; exit 1; fi
"$OUT" -hide_banner -version | grep -q -- '--disable-gpl' || { echo "not an LGPL build" >&2; exit 1; }

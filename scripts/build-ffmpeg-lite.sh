#!/usr/bin/env bash
set -euo pipefail

# Reproducible, static FFmpeg used only for new audio/video/animated-image media.
# Run inside an MSYS2 UCRT64 shell with GCC, make, NASM, pkgconf, aom and opus.
FFMPEG_TAG="n8.1.2"
FFMPEG_COMMIT="38b88335f99e76ed89ff3c93f877fdefce736c13"

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
destination="${1:-$project_root/src-tauri/tools/ffmpeg.exe}"
if [[ -n "${LOCALAPPDATA:-}" ]]; then
  default_cache="$(cygpath -u "$LOCALAPPDATA")/vault-notes-build"
else
  default_cache="$project_root/.cache/media-tools"
fi
cache_root="${VAULT_NOTES_MEDIA_BUILD_DIR:-$default_cache}"
source_dir="$cache_root/ffmpeg-$FFMPEG_TAG"

for command in git make gcc pkg-config nasm; do
  command -v "$command" >/dev/null || {
    echo "Missing build dependency: $command" >&2
    exit 1
  }
done
pkg-config --exists --static aom opus || {
  echo "Missing static aom/opus development packages." >&2
  exit 1
}

mkdir -p "$cache_root" "$(dirname "$destination")"
if [[ ! -d "$source_dir/.git" ]]; then
  git clone --filter=blob:none --depth 1 --branch "$FFMPEG_TAG" \
    https://github.com/FFmpeg/FFmpeg.git "$source_dir"
fi
actual_commit="$(git -C "$source_dir" rev-parse HEAD)"
if [[ "$actual_commit" != "$FFMPEG_COMMIT" ]]; then
  echo "FFmpeg source mismatch: expected $FFMPEG_COMMIT, got $actual_commit" >&2
  exit 1
fi

cd "$source_dir"
if [[ -f config.mak ]]; then
  make distclean
fi

./configure \
  --target-os=mingw32 \
  --arch=x86_64 \
  --enable-static \
  --disable-shared \
  --disable-autodetect \
  --disable-everything \
  --disable-doc \
  --disable-debug \
  --disable-network \
  --disable-avdevice \
  --enable-small \
  --enable-ffmpeg \
  --disable-ffprobe \
  --enable-zlib \
  --enable-libaom \
  --enable-libopus \
  --pkg-config-flags=--static \
  --extra-cflags="-Os -ffunction-sections -fdata-sections" \
  --extra-ldflags="-static -static-libgcc -Wl,--gc-sections" \
  --enable-protocol=file,pipe \
  --enable-muxer=webm,opus,null \
  --enable-demuxer=mov,matroska,ogg,mp3,wav,flac,avi,asf,apng,gif,image2,image2pipe,image_gif_pipe,image_png_pipe,image_webp_pipe,mjpeg,h264,hevc,mpegvideo,mpegts \
  --enable-parser=aac,ac3,av1,gif,h264,hevc,mpeg4video,mpegaudio,mpegvideo,opus,png,vorbis,vp8,vp9,webp \
  --enable-decoder=aac,aac_fixed,aac_latm,ac3,eac3,alac,flac,mp1,mp1float,mp2,mp2float,mp3,mp3float,opus,vorbis,wmalossless,wmapro,wmav1,wmav2,pcm_alaw,pcm_f32le,pcm_f64le,pcm_mulaw,pcm_s16be,pcm_s16le,pcm_s24be,pcm_s24le,pcm_s32be,pcm_s32le,pcm_u8,libaom_av1,h263,h264,hevc,mpeg1video,mpeg2video,mpeg4,msmpeg4v1,msmpeg4v2,msmpeg4v3,vc1,wmv1,wmv2,wmv3,vp8,vp9,theora,prores,dnxhd,mjpeg,png,apng,gif,webp,webp_anim,bmp,tiff \
  --enable-encoder=libaom_av1,libopus,wrapped_avframe,pcm_s16le \
  --enable-filter=scale,fps,aresample,aformat,format,transpose,hflip,vflip,crop,pad,setpts,trim,atrim

make -j"$(nproc)" ffmpeg.exe
strip ffmpeg.exe
cp -f ffmpeg.exe "$destination"

size="$(wc -c < "$destination")"
if (( size > 40 * 1024 * 1024 )); then
  echo "Lite FFmpeg unexpectedly exceeds 40 MiB: $size bytes" >&2
  exit 1
fi
"$destination" -hide_banner -version | head -n 1
echo "Built $destination ($size bytes)"

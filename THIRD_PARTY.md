# Third-party software

ScreenLoop bundles **FFmpeg** as a separate executable (`ffmpeg`, run as a child process).
It is built LGPL-only (`--disable-gpl --disable-nonfree`) with libopus (BSD) and Apple frameworks.
Source and build recipe: `scripts/build-ffmpeg.sh` (official tarballs, SHA-256 pinned:
FFmpeg 7.1.1 https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz, Opus 1.5.2 https://downloads.xiph.org/releases/opus/).
You may replace the bundled `ffmpeg` with your own build.

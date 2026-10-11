export interface PartInfo { path: string; audio_path: string; start_seconds: number; duration_seconds: number; size_bytes: number }

/** Map a time on the session clock to the part that holds it and the seek offset inside that part. */
export function locate(parts: PartInfo[], t: number): { index: number; offset: number } | null {
  for (const [index, p] of parts.entries()) {
    if (t >= p.start_seconds && t < p.start_seconds + p.duration_seconds) return { index, offset: t - p.start_seconds };
  }
  // Inside a gap between runs (paused time is skipped): snap to the next part's start.
  const next = parts.findIndex((p) => p.start_seconds > t);
  return next >= 0 ? { index: next, offset: 0 } : null;
}

export const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s) % 60).padStart(2, "0")}`;


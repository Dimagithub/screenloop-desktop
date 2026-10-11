import { expect, test } from "bun:test";
import { locate, type PartInfo } from "./timeline";

const part = (start: number, dur: number): PartInfo => ({ path: "", audio_path: "", start_seconds: start, duration_seconds: dur, size_bytes: 0 });

test("locate maps session time to part and offset", () => {
  const parts = [part(0, 120), part(120, 120), part(240, 30)];
  expect(locate(parts, 10)).toEqual({ index: 0, offset: 10 });
  expect(locate(parts, 130)).toEqual({ index: 1, offset: 10 });
  expect(locate(parts, 269)).toEqual({ index: 2, offset: 29 });
  expect(locate(parts, 400)).toBeNull();
});

test("locate snaps a gap to the next part", () => {
  expect(locate([part(0, 10), part(15, 10)], 12)).toEqual({ index: 1, offset: 0 });
});

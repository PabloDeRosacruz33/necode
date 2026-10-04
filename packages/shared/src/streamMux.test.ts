import { describe, expect, it } from "vite-plus/test";

import { decodeMuxFrame, encodeMuxFrame } from "./streamMux.ts";

describe("stream mux frames", () => {
  it("round-trips every kind of frame", () => {
    const bytes = new Uint8Array([104, 111, 108, 97]);
    expect(decodeMuxFrame(encodeMuxFrame({ kind: "open", stream: 7, port: 8081 }))).toEqual({
      kind: "open",
      stream: 7,
      port: 8081,
    });
    expect(decodeMuxFrame(encodeMuxFrame({ kind: "data", stream: 70000, bytes }))).toEqual({
      kind: "data",
      stream: 70000,
      bytes,
    });
    expect(decodeMuxFrame(encodeMuxFrame({ kind: "close", stream: 7 }))).toEqual({
      kind: "close",
      stream: 7,
    });
  });

  it("drops frames it does not understand", () => {
    expect(decodeMuxFrame(new Uint8Array([9, 0, 0, 0, 1]))).toBeNull();
    expect(decodeMuxFrame(new Uint8Array([1, 0]))).toBeNull();
  });
});

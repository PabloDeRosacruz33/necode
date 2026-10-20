import { describe, expect, it } from "vite-plus/test";

import { nextPermanentTaskName } from "./taskLifecycle.ts";

describe("nextPermanentTaskName", () => {
  it("continues a permanent thread in its next version and leaves other tasks alone", () => {
    expect(nextPermanentTaskName("pablo/fabulas-v1")).toBe("fabulas-v2");
    expect(nextPermanentTaskName("roi/necode-v9")).toBe("necode-v10");
    expect(nextPermanentTaskName("pablo/arreglar-menu")).toBeNull();
    expect(nextPermanentTaskName("pablo/v2-del-menu")).toBeNull();
  });
});

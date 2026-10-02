import { describe, expect, it } from "vite-plus/test";

import { findBuiltAppPath } from "./macApp.ts";

describe("findBuiltAppPath", () => {
  it("takes the last .app path the build printed, spaces included", () => {
    expect(
      findBuiltAppPath(
        [
          "[apple-local] DerivedData: /tmp/necora-product-staging-mac-tarea",
          "** BUILD SUCCEEDED **",
          "[apple-local] Resultado: /tmp/necora-product-staging-mac-tarea/Build/Products/Staging/Necora Staging.app",
        ].join("\n"),
      ),
    ).toBe("/tmp/necora-product-staging-mac-tarea/Build/Products/Staging/Necora Staging.app");
  });

  it("returns null when no app was printed", () => {
    expect(findBuiltAppPath("** BUILD FAILED **\n")).toBeNull();
  });
});

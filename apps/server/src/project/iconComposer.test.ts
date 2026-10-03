import { describe, expect, it } from "vite-plus/test";

import { iconComposerColor, renderIconComposerSvg } from "./iconComposer.ts";

describe("renderIconComposerSvg", () => {
  it("draws the background and places the tinted artwork by scale and offset", () => {
    const svg = renderIconComposerSvg(
      {
        fill: { "linear-gradient": ["display-p3:0.3,0.7,0.9,1", "display-p3:0.1,0.3,0.9,1"] },
        groups: [
          {
            layers: [
              {
                "image-name": "glyph.svg",
                fill: { solid: "srgb:1,1,1,1" },
                position: { scale: 10, "translation-in-points": [-12, 0] },
              },
            ],
          },
        ],
      },
      (name) =>
        name === "glyph.svg"
          ? '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 40"><path d="M0 0h20v40z"/></svg>'
          : null,
    );
    expect(svg).toContain('stop-color="color(display-p3 0.3 0.7 0.9)"');
    // 200x400 artwork centred on 1024, moved 12 points left.
    expect(svg).toContain('<svg x="400" y="312" width="200" height="400" viewBox="0 0 20 40">');
    expect(svg).toContain('mask="url(#shape1)"');
    expect(svg).toContain('stop-color="rgb(255 255 255)"');
  });

  it("parses Icon Composer colors and rejects anything else", () => {
    expect(iconComposerColor("display-p3:0.5,0.25,1.00000,0.5")).toEqual({
      color: "color(display-p3 0.5 0.25 1)",
      opacity: 0.5,
    });
    expect(iconComposerColor("blue")).toBeNull();
  });
});

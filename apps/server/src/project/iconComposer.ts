/**
 * Icon Composer (`*.icon`) bundles, the app icon format of current Xcode: an `icon.json` with a
 * background fill and layers of SVG artwork. Necode draws a flat SVG of it for the project icon,
 * ignoring the glass, shadow and translucency effects.
 */

const CANVAS = 1024;
/** Apple's icon corner radius at 1024 points. */
const CORNER_RADIUS = 229;

interface Point {
  readonly x: number;
  readonly y: number;
}
interface Fill {
  readonly colors: ReadonlyArray<string>;
  readonly start: Point;
  readonly stop: Point;
}

/** `display-p3:r,g,b,a` (or `srgb:` / `extended-srgb:`) as a CSS color and an opacity. */
export function iconComposerColor(
  value: string,
): { readonly color: string; readonly opacity: number } | null {
  const match = /^([a-z0-9-]+):([\d.]+),([\d.]+),([\d.]+)(?:,([\d.]+))?$/.exec(value.trim());
  if (!match) return null;
  const [r, g, b] = [match[2], match[3], match[4]].map(Number) as [number, number, number];
  const opacity = match[5] === undefined ? 1 : Number(match[5]);
  const color =
    match[1] === "display-p3"
      ? `color(display-p3 ${r} ${g} ${b})`
      : `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
  return { color, opacity };
}

/** The same Icon Composer color moved `amount` of the way towards white. */
function lighten(value: string, amount: number): string {
  const match = /^([a-z0-9-]+):([\d.]+),([\d.]+),([\d.]+)(,[\d.]+)?$/.exec(value.trim());
  if (!match) return value;
  const mix = (channel: string) => (Number(channel) + (1 - Number(channel)) * amount).toFixed(5);
  return `${match[1]}:${mix(match[2]!)},${mix(match[3]!)},${mix(match[4]!)}${match[5] ?? ""}`;
}

function readPoint(value: unknown, fallback: Point): Point {
  const point = value as { x?: unknown; y?: unknown } | undefined;
  return typeof point?.x === "number" && typeof point.y === "number"
    ? { x: point.x, y: point.y }
    : fallback;
}

function readFill(value: unknown): Fill | null {
  const fill = value as
    | {
        "linear-gradient"?: unknown;
        "automatic-gradient"?: unknown;
        solid?: unknown;
        orientation?: { start?: unknown; stop?: unknown };
      }
    | undefined;
  if (!fill) return null;
  const top = { x: 0.5, y: 0 };
  const bottom = { x: 0.5, y: 1 };
  if (Array.isArray(fill["linear-gradient"])) {
    const colors = fill["linear-gradient"].filter(
      (entry): entry is string => typeof entry === "string",
    );
    if (colors.length === 0) return null;
    return {
      colors,
      start: readPoint(fill.orientation?.start, top),
      stop: readPoint(fill.orientation?.stop, bottom),
    };
  }
  if (typeof fill.solid === "string") return { colors: [fill.solid], start: top, stop: bottom };
  // One color that Icon Composer turns into a gentle top-to-bottom gradient.
  if (typeof fill["automatic-gradient"] === "string") {
    const base = fill["automatic-gradient"];
    return { colors: [lighten(base, 0.12), base], start: top, stop: bottom };
  }
  return null;
}

function gradient(id: string, fill: Fill): string {
  const stops = fill.colors.flatMap((value, index) => {
    const parsed = iconComposerColor(value);
    if (!parsed) return [];
    const offset = fill.colors.length === 1 ? 0 : index / (fill.colors.length - 1);
    return [
      `<stop offset="${offset}" stop-color="${parsed.color}" stop-opacity="${parsed.opacity}"/>`,
    ];
  });
  return `<linearGradient id="${id}" x1="${fill.start.x}" y1="${fill.start.y}" x2="${fill.stop.x}" y2="${fill.stop.y}">${stops.join("")}</linearGradient>`;
}

/** The artwork's viewBox size and its markup without the outer `<svg>` element. */
function unwrapSvg(
  source: string,
): { readonly width: number; readonly height: number; readonly body: string } | null {
  const open = /<svg\b[^>]*>/i.exec(source);
  const close = source.lastIndexOf("</svg>");
  if (!open || close < open.index) return null;
  const viewBox = /viewBox=["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(
    open[0],
  );
  const width = Number(viewBox?.[1] ?? /\bwidth=["']([\d.]+)/i.exec(open[0])?.[1]);
  const height = Number(viewBox?.[2] ?? /\bheight=["']([\d.]+)/i.exec(open[0])?.[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height, body: source.slice(open.index + open[0].length, close) };
}

/**
 * A flat SVG of an Icon Composer icon: the background fill on Apple's rounded square, then each
 * layer's artwork placed by its scale and offset, tinted by the layer's own fill when it has one.
 * Null when the description has nothing drawable.
 */
export function renderIconComposerSvg(
  iconJson: unknown,
  readLayer: (imageName: string) => string | null,
): string | null {
  const icon = iconJson as { fill?: unknown; groups?: unknown } | null;
  if (!icon || typeof icon !== "object") return null;
  const defs: string[] = [];
  const parts: string[] = [];

  const background = readFill(icon.fill);
  if (background) defs.push(gradient("bg", background));
  parts.push(
    `<rect width="${CANVAS}" height="${CANVAS}" rx="${CORNER_RADIUS}" fill="${background ? "url(#bg)" : "#fff"}"/>`,
  );

  const groups = Array.isArray(icon.groups) ? icon.groups : [];
  let index = 0;
  // Icon Composer lists the frontmost group and layer first; SVG paints later elements on top.
  for (const group of [...groups].reverse()) {
    const layers = Array.isArray((group as { layers?: unknown }).layers)
      ? ((group as { layers: unknown[] }).layers as unknown[])
      : [];
    for (const layer of [...layers].reverse()) {
      const entry = layer as {
        "image-name"?: unknown;
        hidden?: unknown;
        fill?: unknown;
        opacity?: unknown;
        position?: { scale?: unknown; "translation-in-points"?: unknown };
      };
      if (entry.hidden === true || typeof entry["image-name"] !== "string") continue;
      const source = readLayer(entry["image-name"]);
      const art = source ? unwrapSvg(source) : null;
      if (!art) continue;
      const scale = typeof entry.position?.scale === "number" ? entry.position.scale : 1;
      const offset = Array.isArray(entry.position?.["translation-in-points"])
        ? (entry.position["translation-in-points"] as unknown[]).map((value) =>
            typeof value === "number" ? value : 0,
          )
        : [0, 0];
      const width = art.width * scale;
      const height = art.height * scale;
      const x = (CANVAS - width) / 2 + (offset[0] ?? 0);
      const y = (CANVAS - height) / 2 + (offset[1] ?? 0);
      const placed = `<svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="0 0 ${art.width} ${art.height}">${art.body}</svg>`;
      const tint = readFill(entry.fill);
      const opacity =
        typeof entry.opacity === "number" && entry.opacity < 1 ? ` opacity="${entry.opacity}"` : "";
      index += 1;
      if (!tint) {
        parts.push(opacity ? `<g${opacity}>${placed}</g>` : placed);
        continue;
      }
      // The layer's fill replaces the artwork's colors: its shape becomes an alpha mask.
      defs.push(gradient(`fill${index}`, tint));
      defs.push(`<mask id="shape${index}" style="mask-type:alpha">${placed}</mask>`);
      parts.push(
        `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="url(#fill${index})" mask="url(#shape${index})"${opacity}/>`,
      );
    }
  }

  // Artwork never spills past the icon's rounded square.
  defs.push(
    `<clipPath id="squircle"><rect width="${CANVAS}" height="${CANVAS}" rx="${CORNER_RADIUS}"/></clipPath>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}"><defs>${defs.join("")}</defs><g clip-path="url(#squircle)">${parts.join("")}</g></svg>`;
}

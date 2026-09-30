import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";

const PROVIDER_ACCENT_SWATCHES = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
] as const;

/** Preset accent swatches plus a custom picker, for choosing an instance's color. */
export function ProviderAccentSwatches(props: {
  readonly displayName: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <ProviderAccentColorPicker
        displayName={props.displayName}
        value={props.value || undefined}
        onCommit={props.onChange}
        layout="inline"
      />
      <div className="flex flex-wrap gap-1.5">
        {PROVIDER_ACCENT_SWATCHES.map((swatch) => {
          const selected = props.value.toLowerCase() === swatch;
          return (
            <button
              key={swatch}
              type="button"
              className={cn(
                "size-6 cursor-pointer rounded-full border transition",
                selected
                  ? "scale-110 border-foreground ring-2 ring-ring ring-offset-1 ring-offset-background"
                  : "border-black/10 hover:scale-105 dark:border-white/20",
              )}
              style={{ backgroundColor: swatch }}
              onClick={() => props.onChange(swatch)}
              aria-label={`Use ${swatch} accent`}
            />
          );
        })}
      </div>
      {props.value ? (
        <Button type="button" size="xs" variant="ghost-muted" onClick={() => props.onChange("")}>
          Clear
        </Button>
      ) : null}
    </div>
  );
}

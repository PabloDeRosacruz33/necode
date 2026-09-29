import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

/**
 * The Necode brand mark, matching the desktop sidebar's T3Wordmark SVG
 * (apps/web Sidebar.tsx). Width derives from the viewBox aspect ratio.
 */
export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 79 / 93;
  return (
    <Svg
      accessibilityLabel="Necode"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="10 3 79 93"
    >
      <ThemedPath
        d="M46 4 L56 52 Q57 55 59 52 L59 14 L86 44 Q88 47 86 50 L55 93 Q52 96 49 93 L13 50 Q11 47 13 44 Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}

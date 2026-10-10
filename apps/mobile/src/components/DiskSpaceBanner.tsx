import { diskSpaceNotice } from "@t3tools/client-runtime/state/diskSpace";
import type { EnvironmentId } from "@t3tools/contracts";
import { View } from "react-native";

import { cn } from "../lib/cn";
import { useServerDiskSpace } from "../state/diskSpace";
import { AppText as Text } from "./AppText";

/** Shown above the composer while the environment's disk is running out of room. */
export function DiskSpaceBanner(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
}) {
  const notice = diskSpaceNotice(
    useServerDiskSpace(props.environmentId),
    props.environmentLabel ?? "este equipo",
  );
  if (!notice) return null;
  const critical = notice.severity === "error";
  return (
    <View className="shrink-0 px-4 pb-3">
      <View
        className={cn(
          "rounded-2xl border px-3.5 py-3",
          critical ? "border-danger-border bg-danger" : "border-warning-border bg-warning",
        )}
      >
        <Text
          className={cn(
            "text-sm font-t3-medium",
            critical ? "text-danger-foreground" : "text-warning-foreground",
          )}
        >
          {notice.title}
        </Text>
      </View>
    </View>
  );
}

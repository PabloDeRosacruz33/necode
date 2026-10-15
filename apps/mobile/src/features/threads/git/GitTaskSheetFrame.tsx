import { useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import { Platform, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../../components/AndroidScreenHeader";
import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { MaterialScreenContent } from "../../../components/MaterialScreenContent";
import { cn } from "../../../lib/cn";
import { NativeStackScreenOptions } from "../../../native/StackHeader";

/** Title, description and scrolling body of the task sheets (continue, duplicate, merge). */
export function GitTaskSheetFrame(props: {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  return (
    <View
      collapsable={false}
      className="bg-sheet ios:flex-1"
      style={Platform.OS === "android" ? { maxHeight: windowHeight * 0.92 } : undefined}
    >
      {Platform.OS === "android" ? (
        <NativeStackScreenOptions
          options={{ sheetCornerRadius: 28, sheetAllowedDetents: "fitToContents" }}
        />
      ) : null}
      {Platform.OS === "android" ? (
        <AndroidSheetHeader
          title={props.title}
          onBack={() => navigation.goBack()}
          hideBottomBorder
        />
      ) : null}
      <MaterialScreenContent fitToContents>
        <ScrollView
          className="android:shrink android:grow-0 ios:flex-1"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerClassName="gap-3 android:p-2 ios:px-5 ios:pt-5"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {Platform.OS !== "android" ? (
            <Text className="text-2xl font-t3-bold">{props.title}</Text>
          ) : null}
          <Text className="text-foreground-secondary text-sm leading-normal android:px-2">
            {props.description}
          </Text>
          {props.children}
        </ScrollView>
      </MaterialScreenContent>
    </View>
  );
}

/** A labelled single-choice list inside a task sheet. */
export function GitTaskChoiceList<T extends string>(props: {
  readonly label: string;
  readonly value: T;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly onChange: (value: T) => void;
}) {
  return (
    <View className="gap-1.5">
      <Text className="px-1 text-xs font-t3-bold text-foreground-muted">{props.label}</Text>
      <View className="overflow-hidden bg-card android:rounded-[20px] ios:rounded-[18px] ios:border ios:border-border">
        {props.options.map((option, index) => (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ selected: option.value === props.value }}
            className={cn(
              "min-h-12 flex-row items-center justify-between px-4 py-3 active:bg-subtle",
              index > 0 && Platform.OS !== "android" && "border-t border-border",
            )}
            onPress={() => props.onChange(option.value)}
          >
            <Text className="shrink text-base text-foreground">{option.label}</Text>
            {option.value === props.value ? (
              <SymbolView
                name="checkmark.circle"
                size={18}
                tintColorClassName="accent-icon"
                type="monochrome"
              />
            ) : null}
          </Pressable>
        ))}
      </View>
    </View>
  );
}

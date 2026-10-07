import type { ReactNode } from "react";
import { StyleSheet, Text } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useAppTheme } from "@/context/theme";

// How far the message follows the finger, and how far it has to be pulled
// for the reply to trigger.
const MAX_OFFSET = 80;
const REPLY_OFFSET = 56;

// The message slides back without bouncing past its place.
const RETURN_ANIMATION = { duration: 180, easing: Easing.out(Easing.quad) };

// Drag a message to the right to reply to it.
export default function SwipeToReply({
  onReply,
  children,
}: {
  onReply: () => void;
  children: ReactNode;
}) {
  const { colors } = useAppTheme();
  const offset = useSharedValue(0);

  const pan = Gesture.Pan()
    // Only a horizontal drag to the right starts it; vertical movement is
    // left to the list's scrolling.
    .activeOffsetX([Number.MIN_SAFE_INTEGER, 12])
    .failOffsetX([-12, Number.MAX_SAFE_INTEGER])
    .failOffsetY([-12, 12])
    .onUpdate((event) => {
      offset.value = Math.min(MAX_OFFSET, Math.max(0, event.translationX));
    })
    .onEnd(() => {
      if (offset.value >= REPLY_OFFSET) {
        scheduleOnRN(onReply);
      }

      offset.value = withTiming(0, RETURN_ANIMATION);
    })
    // Also when the gesture was cancelled instead of ended.
    .onFinalize(() => {
      if (offset.value !== 0) {
        offset.value = withTiming(0, RETURN_ANIMATION);
      }
    });

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: offset.value }],
  }));

  // The reply arrow fades and grows in as the message is pulled.
  const iconStyle = useAnimatedStyle(() => {
    const progress = interpolate(
      offset.value,
      [0, REPLY_OFFSET],
      [0, 1],
      Extrapolation.CLAMP,
    );

    return {
      opacity: progress,
      transform: [{ scale: 0.5 + progress * 0.5 }],
    };
  });

  return (
    <GestureDetector gesture={pan}>
      <Animated.View>
        <Animated.View
          style={[
            styles.icon,
            { backgroundColor: colors.panelAlt, borderColor: colors.line },
            iconStyle,
          ]}
        >
          <Text style={[styles.iconText, { color: colors.text }]}>↩</Text>
        </Animated.View>

        <Animated.View style={rowStyle}>{children}</Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  icon: {
    position: "absolute",
    left: 4,
    top: "50%",
    marginTop: -16,
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },

  iconText: {
    fontSize: 16,
    fontWeight: "700",
  },
});

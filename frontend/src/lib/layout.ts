import { useWindowDimensions } from "react-native";
import { WIDE_LAYOUT_MIN_WIDTH } from "@/theme/colors";

// Wide screens (tablets, desktop browsers, Mac) show the chats list and the
// open chat side by side.
export function useIsWide() {
  return useWindowDimensions().width >= WIDE_LAYOUT_MIN_WIDTH;
}

// Width of the chats list next to the open chat.
export function useSidebarWidth() {
  const { width } = useWindowDimensions();

  return Math.round(Math.min(400, Math.max(300, width * 0.32)));
}

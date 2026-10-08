import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useAppTheme } from "@/context/theme";
import { EMOJI_CATEGORIES, recentEmoji, rememberEmoji } from "@/lib/emoji";
import { radius } from "@/theme/colors";

// Emoji to pick, by category, with the recently used first: for the
// message being written and for reactions.
export default function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const { colors } = useAppTheme();
  const [recent, setRecent] = useState<string[]>([]);
  const [category, setCategory] = useState(-1);

  useEffect(() => {
    let current = true;

    recentEmoji().then((saved) => {
      if (current) {
        setRecent(saved);

        if (saved.length === 0) {
          setCategory(0);
        }
      }
    });

    return () => {
      current = false;
    };
  }, []);

  const shown = category < 0 ? recent : EMOJI_CATEGORIES[category].emoji;

  const pick = (emoji: string) => {
    onPick(emoji);
    rememberEmoji(emoji).catch(() => {});
  };

  return (
    <View style={[styles.picker, { backgroundColor: colors.panel, borderColor: colors.line }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
        {[{ name: "Recent", icon: "🕘" }, ...EMOJI_CATEGORIES].map((tab, i) => (
          <Pressable
            key={tab.name}
            onPress={() => setCategory(i - 1)}
            accessibilityRole="tab"
            accessibilityLabel={tab.name}
            accessibilityState={{ selected: category === i - 1 }}
            style={[styles.tab, category === i - 1 && { backgroundColor: colors.accentSoft }]}
          >
            <Text style={styles.tabIcon}>{tab.icon}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <ScrollView style={styles.grid} contentContainerStyle={styles.gridContent} keyboardShouldPersistTaps="always">
        {shown.length === 0 ? (
          <Text style={[styles.empty, { color: colors.muted }]}>Emoji you use show here.</Text>
        ) : (
          shown.map((emoji) => (
            <Pressable
              key={emoji}
              onPress={() => pick(emoji)}
              accessibilityRole="button"
              accessibilityLabel={emoji}
              style={({ hovered, pressed }) => [styles.cell, (hovered || pressed) && { backgroundColor: colors.hover }]}
            >
              <Text style={styles.emoji}>{emoji}</Text>
            </Pressable>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  picker: {
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    width: "100%",
    maxWidth: 380,
  },

  tabs: {
    paddingHorizontal: 6,
    paddingVertical: 6,
    gap: 2,
  },

  tab: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },

  tabIcon: {
    fontSize: 18,
  },

  grid: {
    height: 220,
  },

  gridContent: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: 6,
    paddingBottom: 8,
  },

  cell: {
    width: 40,
    height: 40,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },

  emoji: {
    fontSize: 24,
  },

  empty: {
    padding: 16,
    fontSize: 14,
  },
});

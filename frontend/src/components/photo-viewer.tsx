import { useEffect, useState } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Image } from "expo-image";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/context/auth";
import { loadAttachment } from "@/lib/attachments";
import { imageSource, saveFile } from "@/lib/files";
import type { Attachment } from "@/lib/payload";

// The chat's photos on the whole screen, one at a time: arrows (and the
// keyboard's) go through them, Save downloads the one shown.
export default function PhotoViewer({
  photos,
  start,
  onClose,
  onError,
}: {
  photos: Attachment[];
  start: number;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const { withToken } = useAuth();
  const [index, setIndex] = useState(start);
  const [shown, setShown] = useState<{ id: string; uri: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const photo = photos[index];

  const go = (step: number) => setIndex((current) => Math.max(0, Math.min(photos.length - 1, current + step)));

  useEffect(() => {
    if (!photo) {
      return;
    }

    let current = true;
    let uri: string | null = null;

    withToken((token) => loadAttachment(token, photo)).then(
      (bytes) => {
        if (current) {
          uri = imageSource(bytes, photo.mime);
          setShown({ id: photo.id, uri });
        }
      },
      (e) => current && onError(e instanceof Error ? e.message : "Failed to load the photo"),
    );

    return () => {
      current = false;

      if (uri?.startsWith("blob:")) {
        URL.revokeObjectURL(uri);
      }
    };
  }, [photo, withToken, onError]);

  // Web: ← → to go through, Esc to close.
  useEffect(() => {
    if (Platform.OS !== "web") {
      return;
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        setIndex((current) => Math.max(0, current - 1));
      } else if (event.key === "ArrowRight") {
        setIndex((current) => Math.min(photos.length - 1, current + 1));
      } else if (event.key === "Escape") {
        onClose();
      } else {
        return;
      }

      event.preventDefault();
    };

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [photos.length, onClose]);

  const save = async () => {
    setSaving(true);

    try {
      const bytes = await withToken((token) => loadAttachment(token, photo));
      await saveFile(bytes, photo.name, photo.mime);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save the photo");
    } finally {
      setSaving(false);
    }
  };

  if (!photo) {
    return null;
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.bar}>
        <Text style={styles.counter}>
          {index + 1} / {photos.length}
        </Text>
        <View style={styles.actions}>
          <Pressable onPress={save} disabled={saving} accessibilityRole="button" accessibilityLabel="Save the photo" style={styles.button}>
            {saving ? <ActivityIndicator color="#ffffff" /> : <Ionicons name="download-outline" size={24} color="#ffffff" />}
          </Pressable>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" style={styles.button}>
            <Ionicons name="close" size={26} color="#ffffff" />
          </Pressable>
        </View>
      </View>

      <Pressable style={styles.stage} onPress={onClose} accessibilityLabel="Close">
        {shown?.id === photo.id ? (
          <Image source={{ uri: shown.uri }} style={styles.image} contentFit="contain" accessibilityLabel={photo.name} />
        ) : (
          <ActivityIndicator color="#ffffff" />
        )}
      </Pressable>

      {index > 0 ? (
        <Pressable onPress={() => go(-1)} accessibilityRole="button" accessibilityLabel="Previous photo" style={[styles.arrow, styles.left]}>
          <Ionicons name="chevron-back" size={30} color="#ffffff" />
        </Pressable>
      ) : null}
      {index < photos.length - 1 ? (
        <Pressable onPress={() => go(1)} accessibilityRole="button" accessibilityLabel="Next photo" style={[styles.arrow, styles.right]}>
          <Ionicons name="chevron-forward" size={30} color="#ffffff" />
        </Pressable>
      ) : null}

      <Text numberOfLines={1} style={styles.name}>
        {photo.name}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 40,
    backgroundColor: "rgba(0, 0, 0, 0.94)",
  },

  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },

  counter: {
    color: "#ffffff",
    fontSize: 15,
    paddingLeft: 8,
  },

  actions: {
    flexDirection: "row",
  },

  button: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },

  stage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },

  image: {
    width: "100%",
    height: "100%",
  },

  arrow: {
    position: "absolute",
    top: "50%",
    marginTop: -28,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.12)",
  },

  left: {
    left: 12,
  },

  right: {
    right: 12,
  },

  name: {
    color: "rgba(255, 255, 255, 0.75)",
    textAlign: "center",
    padding: 12,
    fontSize: 13,
  },
});

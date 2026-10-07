import { useState } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import Avatar from "@/components/avatar";
import { useAuth, useCurrentUser } from "@/context/auth";
import { useAppTheme } from "@/context/theme";
import { removeAvatar, uploadAvatar } from "@/lib/api";
import { pickAvatar } from "@/lib/avatar-picker";
import { styles } from "./ui";

// The profile picture, with upload and removal.
export function ProfilePhoto() {
  const { colors } = useAppTheme();
  const { withToken, updateUser } = useAuth();
  const user = useCurrentUser();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) {
    return null;
  }

  const change = async () => {
    setError(null);

    try {
      const image = await pickAvatar();

      if (!image) {
        return;
      }

      setBusy(true);
      await updateUser(await withToken((token) => uploadAvatar(token, image)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to set the photo");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setError(null);
    setBusy(true);

    try {
      await updateUser(await withToken(removeAvatar));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove the photo");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.photo}>
      <Pressable
        onPress={change}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={user.avatar_id ? "Change photo" : "Set a photo"}
        style={({ hovered }) => hovered && styles.hovered}
      >
        <Avatar name={user.username} avatarId={user.avatar_id} size={88} />
        <View
          style={[
            styles.photoBadge,
            { backgroundColor: colors.accent, borderColor: colors.panel },
          ]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.onAccent} />
          ) : (
            <Ionicons name="camera" size={16} color={colors.onAccent} />
          )}
        </View>
      </Pressable>

      {user.avatar_id && !busy ? (
        <Pressable onPress={remove} accessibilityRole="button" hitSlop={6}>
          <Text style={[styles.photoAction, { color: colors.muted }]}>
            Remove photo
          </Text>
        </Pressable>
      ) : null}

      {error ? (
        <Text style={[styles.photoError, { color: colors.danger }]}>{error}</Text>
      ) : null}
    </View>
  );
}

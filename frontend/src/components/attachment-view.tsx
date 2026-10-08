import { useEffect, useState } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Image } from "expo-image";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth } from "@/context/auth";
import { useAppTheme } from "@/context/theme";
import { formatSize, isImage, loadAttachment } from "@/lib/attachments";
import { imageSource, saveFile } from "@/lib/files";
import type { Attachment } from "@/lib/payload";

const MAX_WIDTH = 240;
const MAX_HEIGHT = 320;

// The files of a message: pictures shown in the bubble (tapping one shows
// it on the whole screen), other files as a card (tapping one saves it; the
// share sheet on the phones).
export default function AttachmentView({
  attachments,
  own,
  onError,
  onOpenPhoto,
}: {
  attachments: Attachment[];
  own: boolean;
  onError: (message: string) => void;
  onOpenPhoto?: (attachment: Attachment) => void;
}) {
  return (
    <View style={styles.list}>
      {attachments.map((attachment) =>
        isImage(attachment.mime) ? (
          <AttachmentImage
            key={attachment.id}
            attachment={attachment}
            onError={onError}
            onOpen={onOpenPhoto ? () => onOpenPhoto(attachment) : undefined}
          />
        ) : (
          <AttachmentFile key={attachment.id} attachment={attachment} own={own} onError={onError} />
        ),
      )}
    </View>
  );
}

// Saves a file of a message.
function useSave(attachment: Attachment, onError: (message: string) => void) {
  const { withToken } = useAuth();
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);

    try {
      const bytes = await withToken((token) => loadAttachment(token, attachment));
      await saveFile(bytes, attachment.name, attachment.mime);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save the file");
    } finally {
      setSaving(false);
    }
  };

  return { save, saving };
}

function AttachmentImage({
  attachment,
  onError,
  onOpen,
}: {
  attachment: Attachment;
  onError: (message: string) => void;
  onOpen?: () => void;
}) {
  const { colors } = useAppTheme();
  const { withToken } = useAuth();
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const { save, saving } = useSave(attachment, onError);

  useEffect(() => {
    let current = true;
    let shown: string | null = null;

    withToken((token) => loadAttachment(token, attachment)).then(
      (bytes) => {
        if (current) {
          shown = imageSource(bytes, attachment.mime);
          setUri(shown);
        }
      },
      () => current && setFailed(true),
    );

    return () => {
      current = false;

      // Web: release the picture's memory.
      if (shown?.startsWith("blob:")) {
        URL.revokeObjectURL(shown);
      }
    };
  }, [attachment, withToken]);

  const ratio = attachment.width && attachment.height ? attachment.width / attachment.height : 4 / 3;
  const width = Math.min(MAX_WIDTH, attachment.width ?? MAX_WIDTH, MAX_HEIGHT * ratio);
  const size = { width, height: width / ratio };

  return (
    <Pressable
      onPress={onOpen ?? save}
      accessibilityRole="button"
      accessibilityLabel={`Photo ${attachment.name}, tap to ${onOpen ? "open" : "save"}`}
      style={[styles.image, size, { backgroundColor: colors.panelAlt }]}
    >
      {uri ? (
        <Image source={{ uri }} style={size} contentFit="cover" accessibilityIgnoresInvertColors />
      ) : failed ? (
        <Ionicons name="image-outline" size={28} color={colors.muted} />
      ) : (
        <ActivityIndicator color={colors.muted} />
      )}
      {saving ? <ActivityIndicator style={styles.saving} color="#ffffff" /> : null}
    </Pressable>
  );
}

function AttachmentFile({
  attachment,
  own,
  onError,
}: {
  attachment: Attachment;
  own: boolean;
  onError: (message: string) => void;
}) {
  const { colors } = useAppTheme();
  const { save, saving } = useSave(attachment, onError);
  const fg = own ? colors.onAccent : colors.text;

  return (
    <Pressable
      onPress={save}
      accessibilityRole="button"
      accessibilityLabel={`File ${attachment.name}, ${formatSize(attachment.size)}, tap to save`}
      style={[styles.file, { backgroundColor: own ? "rgba(0, 0, 0, 0.12)" : colors.panelAlt }]}
    >
      <View style={[styles.fileIcon, { backgroundColor: own ? colors.onAccent : colors.accent }]}>
        {saving ? (
          <ActivityIndicator size="small" color={own ? colors.accent : colors.onAccent} />
        ) : (
          <Ionicons name="document-outline" size={18} color={own ? colors.accent : colors.onAccent} />
        )}
      </View>
      <View style={styles.fileText}>
        <Text numberOfLines={1} style={[styles.fileName, { color: fg }]}>
          {attachment.name}
        </Text>
        <Text style={[styles.fileSize, { color: fg }]}>{formatSize(attachment.size)}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: 4,
    marginBottom: 4,
  },

  image: {
    borderRadius: 12,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },

  saving: {
    position: "absolute",
  },

  file: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 8,
    borderRadius: 12,
    minWidth: 180,
  },

  fileIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },

  fileText: {
    flexShrink: 1,
  },

  fileName: {
    fontSize: 14,
    fontWeight: "600",
  },

  fileSize: {
    fontSize: 12,
    opacity: 0.75,
  },
});

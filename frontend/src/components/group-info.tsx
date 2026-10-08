import { useState, type ComponentProps } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Avatar from "@/components/avatar";
import Button from "@/components/button";
import ChatAvatar from "@/components/chat-avatar";
import DevBadge from "@/components/dev-badge";
import SafetyCode from "@/components/safety-code";
import TextField from "@/components/text-field";
import { useAuth } from "@/context/auth";
import { useRealtime } from "@/context/realtime";
import { useAppTheme } from "@/context/theme";
import { findUser, setGroupRole, type Chat, type GroupMember } from "@/lib/api";
import { uploadAttachment } from "@/lib/attachments";
import { publicKeyOf, safetyCode } from "@/lib/crypto";
import {
  addGroupMember,
  groupInfo,
  isGroupDistrusted,
  MAX_GROUP_MEMBERS,
  removeGroupMember,
  rotateGroupKey,
  saveGroupInfo,
} from "@/lib/groups";
import { acceptPeerKey, checkPeerKey } from "@/lib/known-keys";
import { pickPhoto } from "@/lib/pick-attachment";
import { cleanUsername, USERNAME_RE, USERNAME_RULES } from "@/lib/validation";
import { radius } from "@/theme/colors";

const ROLE_LABEL = { owner: "owner", admin: "admin", member: "" } as const;

// A group's screen over the chat (placed like ActionMenu): its name and
// photo, its members and what the user may do with them.
export default function GroupInfo({
  chat,
  members,
  onChanged,
  onLeave,
  onDelete,
  onMessage,
  onClose,
}: {
  chat: Chat;
  // null while loading.
  members: GroupMember[] | null;
  // Something changed: reload the members and the chat.
  onChanged: () => void;
  onLeave: () => void;
  onDelete: () => void;
  // Opens the direct chat with a member.
  onMessage: (username: string) => void;
  onClose: () => void;
}) {
  const { colors } = useAppTheme();
  const { state, withToken } = useAuth();
  const { presence, status } = useRealtime();
  const me = state.status === "signedIn" && state.privateKey ? { id: state.user.id, privateKey: state.privateKey } : null;

  const info = groupInfo(chat);
  const admin = chat.role === "owner" || chat.role === "admin";

  const [name, setName] = useState(info?.name ?? "");
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The member whose actions are shown, and whose safety code.
  const [selected, setSelected] = useState<string | null>(null);
  const [codeFor, setCodeFor] = useState<{ member: GroupMember; changed: boolean } | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);

    try {
      await action();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const rename = () =>
    run(async () => {
      if (!name.trim()) {
        throw new Error("Give the group a name");
      }

      await saveGroupInfo(withToken, chat, name.trim());
    });

  const changePhoto = () =>
    run(async () => {
      const file = await pickPhoto();

      if (!file) {
        return;
      }

      const photo = await withToken((token) => uploadAttachment(token, file));
      await saveGroupInfo(withToken, chat, info?.name ?? name, {
        id: photo.id,
        key: photo.key,
        mime: photo.mime,
      });
    });

  const removePhoto = () => run(() => saveGroupInfo(withToken, chat, info?.name ?? name, null));

  const add = () =>
    run(async () => {
      const wanted = cleanUsername(username);

      if (!USERNAME_RE.test(wanted)) {
        throw new Error(USERNAME_RULES);
      }

      if (!me) {
        return;
      }

      const user = await withToken((token) => findUser(token, wanted));
      await addGroupMember(withToken, me, chat, user);
      setUsername("");
    });

  const showCode = async (member: GroupMember) => {
    if (!me || !member.public_key) {
      return;
    }

    const state = await checkPeerKey(me.id, member.id, member.public_key);
    setCodeFor({ member, changed: state === "changed" });
  };

  const canRemove = (member: GroupMember) =>
    member.id !== me?.id &&
    (chat.role === "owner" || (chat.role === "admin" && member.role === "member"));

  return (
    <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close">
      <Pressable style={[styles.card, { backgroundColor: colors.panel }]} onPress={() => {}}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <View style={styles.head}>
            <ChatAvatar chat={chat} size={72} />
            {admin ? (
              <View style={styles.photoActions}>
                <Pressable onPress={changePhoto} disabled={busy} accessibilityRole="button">
                  <Text style={[styles.link, { color: colors.accent }]}>
                    {info?.photo ? "Change photo" : "Add photo"}
                  </Text>
                </Pressable>
                {info?.photo ? (
                  <Pressable onPress={removePhoto} disabled={busy} accessibilityRole="button">
                    <Text style={[styles.link, { color: colors.danger }]}>Remove</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </View>

          {admin ? (
            <View style={styles.inline}>
              <View style={styles.grow}>
                <TextField label="Group name" value={name} onChangeText={setName} maxLength={64} />
              </View>
              <Button
                title="Save"
                variant="secondary"
                disabled={busy || !name.trim() || name.trim() === info?.name}
                onPress={rename}
              />
            </View>
          ) : (
            <Text style={[styles.title, { color: colors.text }]}>{info?.name ?? "Group"}</Text>
          )}

          <Text style={[styles.note, { color: colors.muted }]}>
            {chat.member_count} of {MAX_GROUP_MEMBERS} members. The name, photo and messages are
            end-to-end encrypted with a key only the members have; it changes when someone
            leaves. Members share that key, so compare safety codes with those you need to be
            sure of.
          </Text>

          {isGroupDistrusted(chat.id) ? (
            <Text style={[styles.note, { color: colors.danger }]}>
              A key of this group came from someone whose security key has changed, and is not
              used. Compare safety codes with the members.
            </Text>
          ) : null}

          {error ? <Text style={[styles.note, { color: colors.danger }]}>{error}</Text> : null}

          {admin && chat.member_count < MAX_GROUP_MEMBERS ? (
            <View style={styles.inline}>
              <View style={styles.grow}>
                <TextField
                  label="Add a member"
                  placeholder="@username"
                  value={username}
                  onChangeText={setUsername}
                  maxLength={33}
                  onSubmitEditing={add}
                />
              </View>
              <Button title="Add" variant="secondary" disabled={busy || !username.trim()} onPress={add} />
            </View>
          ) : null}

          {members === null ? (
            <ActivityIndicator color={colors.muted} />
          ) : (
            <View>
              {members.map((member) => {
                const own = member.id === me?.id;
                const online = !own && status === "online" && Boolean(presence[member.id]?.online);
                const open = selected === member.id;

                return (
                  <View key={member.id}>
                    <Pressable
                      onPress={() => setSelected(open || own ? null : member.id)}
                      accessibilityRole="button"
                      style={({ hovered, pressed }) => [
                        styles.member,
                        (hovered || pressed || open) && { backgroundColor: colors.hover },
                      ]}
                    >
                      <Avatar name={member.username} avatarId={member.avatar_id} size={36} online={online} ringColor={colors.panel} />
                      <View style={styles.grow}>
                        <View style={styles.nameRow}>
                          <Text numberOfLines={1} style={[styles.memberName, { color: colors.text }]}>
                            @{member.username}
                            {own ? " (you)" : ""}
                          </Text>
                          {member.is_developer ? <DevBadge /> : null}
                        </View>
                      </View>
                      {ROLE_LABEL[member.role] ? (
                        <Text style={[styles.role, { color: colors.accent }]}>{ROLE_LABEL[member.role]}</Text>
                      ) : null}
                    </Pressable>

                    {open ? (
                      <View style={styles.memberActions}>
                        <Action label="Message" icon="chatbubble-outline" onPress={() => onMessage(member.username)} />
                        {member.public_key ? (
                          <Action label="Safety code" icon="shield-checkmark-outline" onPress={() => showCode(member)} />
                        ) : null}
                        {chat.role === "owner" && member.role !== "owner" ? (
                          <Action
                            label={member.role === "admin" ? "Remove admin" : "Make admin"}
                            icon="star-outline"
                            onPress={() =>
                              run(() =>
                                withToken((token) =>
                                  setGroupRole(token, chat.id, member.id, member.role === "admin" ? "member" : "admin"),
                                ),
                              )
                            }
                          />
                        ) : null}
                        {canRemove(member) && me ? (
                          <Action
                            label="Remove"
                            icon="person-remove-outline"
                            danger
                            onPress={() => run(() => removeGroupMember(withToken, me, chat, member.id))}
                          />
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </View>
          )}

          {admin && me ? (
            <Action
              label="Change the group key"
              icon="key-outline"
              onPress={() => run(() => rotateGroupKey(withToken, me, chat))}
            />
          ) : null}
          <Action label="Leave group" icon="exit-outline" danger onPress={onLeave} />
          {chat.role === "owner" ? (
            <Action label="Delete group" icon="trash-outline" danger onPress={onDelete} />
          ) : null}

          <Button title="Close" variant="secondary" onPress={onClose} />
        </ScrollView>
      </Pressable>

      {codeFor && me && codeFor.member.public_key ? (
        <SafetyCode
          username={codeFor.member.username}
          code={safetyCode(publicKeyOf(me.privateKey), codeFor.member.public_key)}
          keyChanged={codeFor.changed}
          onConfirm={async () => {
            await acceptPeerKey(me.id, codeFor.member.id, codeFor.member.public_key!);
            setCodeFor(null);
          }}
          onClose={() => setCodeFor(null)}
        />
      ) : null}
    </Pressable>
  );
}

function Action({
  label,
  icon,
  danger = false,
  onPress,
}: {
  label: string;
  icon: ComponentProps<typeof Ionicons>["name"];
  danger?: boolean;
  onPress: () => void;
}) {
  const { colors } = useAppTheme();
  const color = danger ? colors.danger : colors.text;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ hovered, pressed }) => [styles.action, (hovered || pressed) && { backgroundColor: colors.hover }]}
    >
      <Ionicons name={icon} size={18} color={color} />
      <Text style={[styles.actionText, { color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 10,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
  },

  card: {
    width: "100%",
    maxWidth: 420,
    maxHeight: "90%",
    borderRadius: radius.card,
  },

  body: {
    padding: 20,
    gap: 14,
  },

  head: {
    alignItems: "center",
    gap: 8,
  },

  photoActions: {
    flexDirection: "row",
    gap: 16,
  },

  link: {
    fontSize: 14,
    fontWeight: "600",
  },

  title: {
    fontSize: 19,
    fontWeight: "700",
    textAlign: "center",
  },

  note: {
    fontSize: 13,
    lineHeight: 19,
  },

  inline: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
  },

  grow: {
    flex: 1,
    minWidth: 0,
  },

  member: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderRadius: radius.input,
  },

  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },

  memberName: {
    fontSize: 15,
    flexShrink: 1,
  },

  role: {
    fontSize: 12,
    fontWeight: "600",
  },

  memberActions: {
    paddingLeft: 46,
  },

  action: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 8,
    paddingVertical: 9,
    borderRadius: radius.input,
  },

  actionText: {
    fontSize: 15,
  },
});

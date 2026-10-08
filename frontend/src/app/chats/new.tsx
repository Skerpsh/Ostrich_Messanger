import { useState } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import AppHeader from "@/components/app-header";
import Avatar from "@/components/avatar";
import Button from "@/components/button";
import QrScanner from "@/components/qr-scanner";
import TextField from "@/components/text-field";
import { useAuth, useCurrentUser } from "@/context/auth";
import { useChats } from "@/context/chats";
import { useAppTheme } from "@/context/theme";
import { findUser, type FoundUser } from "@/lib/api";
import { createGroup, MAX_GROUP_MEMBERS } from "@/lib/groups";
import { useIsWide } from "@/lib/layout";
import { linkPath, parseLink } from "@/lib/links";
import { useStartChat } from "@/lib/use-start-chat";
import { cleanUsername, USERNAME_RE, USERNAME_RULES } from "@/lib/validation";
import { radius } from "@/theme/colors";

export default function NewChatScreen() {
  const router = useRouter();
  const { colors } = useAppTheme();
  const wide = useIsWide();
  const user = useCurrentUser();
  const startChat = useStartChat();

  const [mode, setMode] = useState<"chat" | "group">("chat");
  const [scanning, setScanning] = useState(false);
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const close = () =>
    wide || !router.canGoBack() ? router.replace("/chats") : router.back();

  const open = (chatId: string) =>
    router.replace({ pathname: "/chats/[chatId]", params: { chatId } });

  const submit = async () => {
    // "@alice" and "alice" both work.
    const name = cleanUsername(username);

    if (!USERNAME_RE.test(name)) {
      setError(USERNAME_RULES);
      return;
    }

    if (name.toLowerCase() === user?.username.toLowerCase()) {
      setError("This is your own username");
      return;
    }

    setError(null);
    setLoading(true);

    try {
      open((await startChat(name)).id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create chat");
      setLoading(false);
    }
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      <AppHeader
        onBack={wide ? undefined : close}
        onClose={wide ? close : undefined}
        title={mode === "chat" ? "New chat" : "New group"}
      />

      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
        >
          <View style={[styles.tabs, { backgroundColor: colors.panelAlt }]}>
            {(["chat", "group"] as const).map((tab) => (
              <Pressable
                key={tab}
                onPress={() => {
                  setMode(tab);
                  setError(null);
                }}
                accessibilityRole="tab"
                accessibilityState={{ selected: mode === tab }}
                style={[styles.tab, mode === tab && { backgroundColor: colors.panel }]}
              >
                <Text style={[styles.tabText, { color: mode === tab ? colors.text : colors.muted }]}>
                  {tab === "chat" ? "Chat" : "Group"}
                </Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.scan}>
            <Button
              title="Scan a QR code"
              icon="qr-code-outline"
              variant="secondary"
              onPress={() => {
                setError(null);
                setScanning(true);
              }}
            />
          </View>

          {mode === "group" ? (
            <NewGroup onCreated={open} />
          ) : (
            <View style={[styles.card, { backgroundColor: colors.panel }]}>
              <View style={[styles.icon, { backgroundColor: colors.accentSoft }]}>
                <Ionicons name="person-add-outline" size={26} color={colors.accent} />
              </View>

              <Text style={[styles.text, { color: colors.textSoft }]}>
                Enter the exact @username of the person you want to chat with.
                They can find it in their settings.
              </Text>

              <TextField
                label="Username"
                placeholder="@username"
                value={username}
                onChangeText={(text) => {
                  setUsername(text);
                  setError(null);
                }}
                maxLength={33}
                autoFocus
                returnKeyType="go"
                onSubmitEditing={submit}
              />

              {error ? (
                <Text style={[styles.error, { color: colors.danger }]}>
                  {error}
                </Text>
              ) : null}

              <Button title="Start chat" loading={loading} onPress={submit} />
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {scanning ? (
        <QrScanner
          title="Scan a QR code"
          onClose={() => setScanning(false)}
          onScan={(text) => {
            const link = parseLink(text);
            const path = link && linkPath(link);

            if (path) {
              setScanning(false);
              router.replace(path as never);
              return true;
            }

            if (link?.kind === "safety") {
              setScanning(false);
              setMode("chat");
              setError("That is a safety code: open the chat with them, then Safety code → Scan their code.");
              return true;
            }

            return false;
          }}
        />
      ) : null}
    </View>
  );
}

// A group: its name and members (by @username, each needs encryption set
// up: the group's key is wrapped for them).
function NewGroup({ onCreated }: { onCreated: (chatId: string) => void }) {
  const { colors } = useAppTheme();
  const { state, withToken } = useAuth();
  const { reload } = useChats();
  const user = useCurrentUser();

  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [members, setMembers] = useState<FoundUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);

  const add = async () => {
    const wanted = cleanUsername(username);

    if (!USERNAME_RE.test(wanted)) {
      setError(USERNAME_RULES);
      return;
    }

    if (wanted.toLowerCase() === user?.username.toLowerCase()) {
      setError("You are in the group anyway");
      return;
    }

    if (members.some((m) => m.username.toLowerCase() === wanted.toLowerCase())) {
      setUsername("");
      return;
    }

    if (members.length + 1 >= MAX_GROUP_MEMBERS) {
      setError(`A group can have up to ${MAX_GROUP_MEMBERS} members`);
      return;
    }

    setAdding(true);
    setError(null);

    try {
      const found = await withToken((token) => findUser(token, wanted));

      if (!found.public_key) {
        setError(`@${found.username} has not set up end-to-end encryption yet`);
      } else {
        setMembers((current) => [...current, found]);
        setUsername("");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "User not found");
    } finally {
      setAdding(false);
    }
  };

  const create = async () => {
    const title = name.trim();

    if (!title) {
      setError("Give the group a name");
      return;
    }

    if (members.length === 0) {
      setError("Add at least one member");
      return;
    }

    if (state.status !== "signedIn" || !state.privateKey) {
      return;
    }

    setCreating(true);
    setError(null);

    try {
      const id = await createGroup(
        withToken,
        { id: state.user.id, privateKey: state.privateKey },
        title,
        members,
      );
      await reload();
      onCreated(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create the group");
      setCreating(false);
    }
  };

  return (
    <View style={[styles.card, { backgroundColor: colors.panel }]}>
      <View style={[styles.icon, { backgroundColor: colors.accentSoft }]}>
        <Ionicons name="people-outline" size={26} color={colors.accent} />
      </View>

      <Text style={[styles.text, { color: colors.textSoft }]}>
        Up to {MAX_GROUP_MEMBERS} people. The group&apos;s name, photo and messages are
        end-to-end encrypted: the server never sees them.
      </Text>

      <TextField
        label="Group name"
        placeholder="Name"
        value={name}
        onChangeText={(text) => {
          setName(text);
          setError(null);
        }}
        maxLength={64}
        autoFocus
      />

      <View style={styles.addRow}>
        <View style={styles.addField}>
          <TextField
            label="Members"
            placeholder="@username"
            value={username}
            onChangeText={(text) => {
              setUsername(text);
              setError(null);
            }}
            maxLength={33}
            returnKeyType="done"
            onSubmitEditing={add}
          />
        </View>
        <Button title="Add" variant="secondary" loading={adding} onPress={add} />
      </View>

      {members.length > 0 ? (
        <View style={styles.members}>
          {members.map((member) => (
            <View key={member.id} style={[styles.member, { backgroundColor: colors.panelAlt }]}>
              <Avatar name={member.username} avatarId={member.avatar_id} size={24} />
              <Text style={[styles.memberName, { color: colors.text }]}>@{member.username}</Text>
              <Pressable
                onPress={() => setMembers((current) => current.filter((m) => m.id !== member.id))}
                accessibilityRole="button"
                accessibilityLabel={`Remove @${member.username}`}
                hitSlop={8}
              >
                <Ionicons name="close" size={16} color={colors.muted} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      {error ? <Text style={[styles.error, { color: colors.danger }]}>{error}</Text> : null}

      <Button title="Create group" loading={creating} onPress={create} />
    </View>
  );
}

const styles = StyleSheet.create({
  scan: {
    width: "100%",
    maxWidth: 440,
    alignSelf: "center",
    marginTop: 12,
  },

  tabs: {
    width: "100%",
    maxWidth: 440,
    alignSelf: "center",
    flexDirection: "row",
    borderRadius: radius.pill,
    padding: 3,
    marginTop: 12,
  },

  tab: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 8,
    borderRadius: radius.pill,
  },

  tabText: {
    fontSize: 14,
    fontWeight: "600",
  },

  addRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
  },

  addField: {
    flex: 1,
  },

  members: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },

  member: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: radius.pill,
    paddingLeft: 3,
    paddingRight: 10,
    paddingVertical: 3,
  },

  memberName: {
    fontSize: 14,
  },

  screen: {
    flex: 1,
  },

  body: {
    padding: 20,
  },

  card: {
    width: "100%",
    maxWidth: 440,
    alignSelf: "center",
    borderRadius: radius.card,
    padding: 24,
    gap: 18,
    marginTop: 12,
  },

  icon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
  },

  text: {
    fontSize: 15,
    lineHeight: 22,
  },

  error: {
    fontSize: 14,
  },
});

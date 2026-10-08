import Avatar from "@/components/avatar";
import type { Chat } from "@/lib/api";
import { chatName, groupInfo, useGroupPhoto } from "@/lib/groups";

// A chat's picture: the other user's, or the group's (decrypted here).
export default function ChatAvatar({
  chat,
  size,
  online,
  ringColor,
}: {
  chat: Chat;
  size?: number;
  online?: boolean;
  ringColor?: string;
}) {
  const group = chat.type === "group";
  const uri = useGroupPhoto(group ? groupInfo(chat)?.photo : undefined);

  return (
    <Avatar
      name={chatName(chat)}
      avatarId={chat.type === "direct" ? chat.avatar_id : null}
      uri={uri}
      icon={group ? "people" : chat.type === "saved" ? "bookmark" : undefined}
      size={size}
      online={online}
      ringColor={ringColor}
    />
  );
}

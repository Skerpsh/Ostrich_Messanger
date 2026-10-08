import { attachmentsLabel } from "./attachments";
import { plainText } from "./markup";
import type { Shown } from "./use-chat-crypto";

// One line about a message for the chats list, notifications, quotes:
// its text without formatting, or what files it has.
export function messagePreview(shown: Shown) {
  return plainText(shown.text).trim() || attachmentsLabel(shown.attachments);
}

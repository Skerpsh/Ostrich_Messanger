// Who each chat is with, as last reported by the server (chats list, new
// chat). The chat screen reads it instead of URL params: those can be set
// by anyone through a crafted link, this cache only by server responses.

export type Peer = {
  userId: string;
  username: string;
};

const peers = new Map<string, Peer>();

export function rememberPeer(chatId: string, peer: Peer) {
  peers.set(chatId, peer);
}

export function knownPeer(chatId: string): Peer | null {
  return peers.get(chatId) ?? null;
}

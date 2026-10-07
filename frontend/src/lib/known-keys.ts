import { getItem, setItem } from "./storage";

// The public key each contact had when this device first saw it. A
// different key later means the contact set up a new account key, or the
// server is swapping keys to read the chat: the chat then asks the user to
// compare the safety code. One entry per contact (secure storage on the
// phones limits the size of a value).

function storageKey(ownId: string, peerId: string) {
  return `ostrich-peer-key-${ownId}-${peerId}`;
}

export type PeerKeyState = "first" | "known" | "changed";

// Remembers the key the first time; "changed" if it differs from the one
// remembered.
export async function checkPeerKey(
  ownId: string,
  peerId: string,
  publicKey: string,
): Promise<PeerKeyState> {
  const known = await getItem(storageKey(ownId, peerId));

  if (known === null) {
    await setItem(storageKey(ownId, peerId), publicKey);
    return "first";
  }

  return known === publicKey ? "known" : "changed";
}

// The user has checked the safety code of the new key.
export async function acceptPeerKey(ownId: string, peerId: string, publicKey: string) {
  await setItem(storageKey(ownId, peerId), publicKey);
}

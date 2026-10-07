import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";

const AVATAR_SIZE = 512;

// Lets the user pick a photo and prepares it for upload: a centered square
// (phones also offer their own crop screen; the web picker has none),
// 512x512 JPEG. Converting on the device also handles formats the server
// does not accept, such as HEIC from iPhones. Returns null if cancelled.
export async function pickAvatar(): Promise<Blob | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1,
  });

  if (result.canceled || result.assets.length === 0) {
    return null;
  }

  const asset = result.assets[0];
  const side = Math.min(asset.width, asset.height);

  const context = ImageManipulator.manipulate(asset.uri);

  if (asset.width !== asset.height) {
    context.crop({
      originX: Math.floor((asset.width - side) / 2),
      originY: Math.floor((asset.height - side) / 2),
      width: side,
      height: side,
    });
  }

  context.resize({ width: AVATAR_SIZE, height: AVATAR_SIZE });

  const image = await context.renderAsync();
  const saved = await image.saveAsync({
    format: SaveFormat.JPEG,
    compress: 0.85,
  });

  const blob = await (await fetch(saved.uri)).blob();

  // Some platforms leave the type empty.
  return blob.type ? blob : new Blob([blob], { type: "image/jpeg" });
}

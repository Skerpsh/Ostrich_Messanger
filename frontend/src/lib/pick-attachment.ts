import * as DocumentPicker from "expo-document-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { ApiError } from "./api";
import { MAX_ATTACHMENT_BYTES, type PickedFile } from "./attachments";
import { readUri } from "./files";

// Choosing files to send. Photos are made smaller like in other
// messengers (at most 2048 px, JPEG); other files are sent as they are.

const MAX_PHOTO_SIDE = 2048;

export async function pickPhoto(): Promise<PickedFile | null> {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });

  if (result.canceled || result.assets.length === 0) {
    return null;
  }

  const asset = result.assets[0];

  return photo(asset.uri, asset.width, asset.height, asset.fileName);
}

// A photo made smaller (at most 2048 px, JPEG).
async function photo(uri: string, width: number, height: number, name?: string | null): Promise<PickedFile> {
  const asset = { uri, width, height, fileName: name };
  const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(asset.width, asset.height, 1));
  const context = ImageManipulator.manipulate(asset.uri);

  if (scale < 1) {
    context.resize({
      width: Math.round(asset.width * scale),
      height: Math.round(asset.height * scale),
    });
  }

  const image = await context.renderAsync();
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
  const base = (asset.fileName ?? "photo").replace(/\.[^.]*$/, "") || "photo";

  return {
    bytes: await readUri(saved.uri),
    name: `${base}.jpg`,
    mime: "image/jpeg",
    width: saved.width,
    height: saved.height,
    previewUri: saved.uri,
  };
}

// Photos made smaller; GIFs (moving) and other files as they are.
const RESIZED = /^image\/(jpeg|png|webp)$/;

// A file pasted or dropped into the web app.
export async function fromWebFile(file: File): Promise<PickedFile> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new ApiError("Files can be up to 25 MB", 400);
  }

  if (RESIZED.test(file.type)) {
    const url = URL.createObjectURL(file);

    try {
      const bitmap = await createImageBitmap(file);
      const { width, height } = bitmap;
      bitmap.close();

      // Pasted screenshots are called "image.png".
      return await photo(url, width, height, file.name === "image.png" ? "screenshot" : file.name);
    } catch {
      // Not readable as a picture: sent as a file.
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    name: file.name || "file",
    mime: file.type || "application/octet-stream",
  };
}

export async function pickDocument(): Promise<PickedFile | null> {
  const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });

  if (result.canceled || result.assets.length === 0) {
    return null;
  }

  const asset = result.assets[0];

  if ((asset.size ?? 0) > MAX_ATTACHMENT_BYTES) {
    throw new ApiError("Files can be up to 25 MB", 400);
  }

  const bytes = asset.file
    ? new Uint8Array(await asset.file.arrayBuffer())
    : await readUri(asset.uri);

  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new ApiError("Files can be up to 25 MB", 400);
  }

  return { bytes, name: asset.name, mime: asset.mimeType || "application/octet-stream" };
}

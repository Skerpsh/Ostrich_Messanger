import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import IconButton from "@/components/icon-button";
import { useAppTheme } from "@/context/theme";

// Scanning a QR code with the computer's or phone's camera in the browser:
// the browser's own detector where there is one, jsQR otherwise.

type Detector = { detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]> };

declare global {
  interface Window {
    BarcodeDetector?: new (options: { formats: string[] }) => Detector;
  }
}

export default function QrScanner({
  title,
  onScan,
  onClose,
}: {
  title: string;
  // A code was read; return true to stop (it was what was wanted).
  onScan: (text: string) => boolean;
  onClose: () => void;
}) {
  const { colors } = useAppTheme();
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const onScanRef = useRef(onScan);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
      } catch {
        setError("Ostrich can't use the camera: allow it in the browser and try again.");
        return;
      }

      const element = video.current;

      if (stopped || !element) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      element.srcObject = stream;
      await element.play().catch(() => {});

      const detector = window.BarcodeDetector ? new window.BarcodeDetector({ formats: ["qr_code"] }) : null;
      const jsQR = detector ? null : (await import("jsqr")).default;
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true });

      const scan = async () => {
        if (stopped) {
          return;
        }

        let text: string | null = null;

        try {
          if (detector) {
            text = (await detector.detect(element))[0]?.rawValue ?? null;
          } else if (jsQR && context && element.videoWidth) {
            // Scaled down: faster, and enough for a QR code.
            const scale = Math.min(1, 640 / element.videoWidth);
            canvas.width = Math.round(element.videoWidth * scale);
            canvas.height = Math.round(element.videoHeight * scale);
            context.drawImage(element, 0, 0, canvas.width, canvas.height);
            const image = context.getImageData(0, 0, canvas.width, canvas.height);
            text = jsQR(image.data, image.width, image.height)?.data ?? null;
          }
        } catch {
          // The next frame.
        }

        if (text && onScanRef.current(text)) {
          return;
        }

        timer = setTimeout(scan, 200);
      };

      scan();
    })();

    return () => {
      stopped = true;

      if (timer) {
        clearTimeout(timer);
      }

      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return (
    <View
      // Taps stay here (not the dialog behind it).
      onStartShouldSetResponder={() => true}
      style={[styles.screen, { backgroundColor: "#000000" }]}>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        <IconButton icon="close" label="Close" color="#ffffff" onPress={onClose} />
      </View>
      {error ? (
        <Text style={[styles.error, { color: colors.danger }]}>{error}</Text>
      ) : (
        <View style={styles.view}>
          <video
            ref={video}
            muted
            playsInline
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
          <View style={styles.frame} pointerEvents="none" />
        </View>
      )}
      <Text style={styles.hint}>Point the camera at the QR code</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 20,
  },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 12,
  },

  title: {
    color: "#ffffff",
    fontSize: 17,
    fontWeight: "700",
    paddingLeft: 8,
  },

  view: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },

  frame: {
    position: "absolute",
    width: 240,
    height: 240,
    borderRadius: 24,
    borderWidth: 3,
    borderColor: "rgba(255, 255, 255, 0.85)",
  },

  error: {
    flex: 1,
    padding: 24,
    fontSize: 15,
    textAlign: "center",
  },

  hint: {
    color: "#ffffff",
    textAlign: "center",
    padding: 16,
    fontSize: 14,
  },
});

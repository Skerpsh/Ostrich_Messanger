import { useRef } from "react";
import { CameraView, useCameraPermissions } from "expo-camera";
import { StyleSheet, Text, View } from "react-native";
import Button from "@/components/button";
import IconButton from "@/components/icon-button";

// Scanning a QR code with the phone's camera (the web has its own,
// qr-scanner.web.tsx).
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
  const [permission, requestPermission] = useCameraPermissions();
  const done = useRef(false);

  return (
    <View
      // Taps stay here (not the dialog behind it).
      onStartShouldSetResponder={() => true}
      style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        <IconButton icon="close" label="Close" color="#ffffff" onPress={onClose} />
      </View>
      {permission?.granted ? (
        <View style={styles.view}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={(result) => {
              if (!done.current && onScan(result.data)) {
                done.current = true;
              }
            }}
          />
          <View style={styles.frame} pointerEvents="none" />
        </View>
      ) : (
        <View style={styles.ask}>
          <Text style={styles.hint}>Ostrich needs the camera to scan QR codes.</Text>
          <Button title="Allow the camera" onPress={requestPermission} />
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
    backgroundColor: "#000000",
  },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 12,
    paddingTop: 48,
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
    width: 240,
    height: 240,
    borderRadius: 24,
    borderWidth: 3,
    borderColor: "rgba(255, 255, 255, 0.85)",
  },

  ask: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: 24,
  },

  hint: {
    color: "#ffffff",
    textAlign: "center",
    padding: 16,
    fontSize: 14,
  },
});

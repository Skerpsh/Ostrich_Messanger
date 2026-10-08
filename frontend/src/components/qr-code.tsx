import { useMemo } from "react";
import { View } from "react-native";
import makeQr from "qrcode-generator";

// A QR code of the text, black on white (scanners need the contrast),
// drawn with rows of runs of dark modules.
export default function QrCode({ value, size = 220 }: { value: string; size?: number }) {
  const rows = useMemo(() => {
    const qr = makeQr(0, "M");
    qr.addData(value);
    qr.make();

    const count = qr.getModuleCount();
    const runs: { x: number; length: number }[][] = [];

    for (let row = 0; row < count; row++) {
      const line: { x: number; length: number }[] = [];

      for (let col = 0; col < count; col++) {
        if (!qr.isDark(row, col)) {
          continue;
        }

        const last = line[line.length - 1];

        if (last && last.x + last.length === col) {
          last.length++;
        } else {
          line.push({ x: col, length: 1 });
        }
      }

      runs.push(line);
    }

    return runs;
  }, [value]);

  // A quiet zone of 4 modules around it.
  const cell = size / (rows.length + 8);

  return (
    <View
      accessibilityRole="image"
      accessibilityLabel="QR code"
      style={{ width: size, height: size, backgroundColor: "#ffffff", padding: cell * 4 }}
    >
      {rows.map((line, row) => (
        <View key={row} style={{ height: cell }}>
          {line.map((run) => (
            <View
              key={run.x}
              style={{
                position: "absolute",
                left: run.x * cell,
                width: run.length * cell + 0.5,
                height: cell + 0.5,
                backgroundColor: "#000000",
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

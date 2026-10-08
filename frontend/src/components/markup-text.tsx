import { Linking, Text, type StyleProp, type TextStyle } from "react-native";
import { parseMarkup } from "@/lib/markup";

// Message text with its formatting (lib/markup.ts); links open in the
// browser, @mentions stand out.
export default function MarkupText({
  text,
  style,
  codeBackground,
  linkColor,
  selectable,
}: {
  text: string;
  style: StyleProp<TextStyle>;
  codeBackground: string;
  linkColor: string;
  selectable?: boolean;
}) {
  return (
    <Text selectable={selectable} style={style}>
      {parseMarkup(text).map((span, i) => (
        <Text
          key={i}
          onPress={span.link ? () => Linking.openURL(span.link!) : undefined}
          style={[
            span.bold && { fontWeight: "700" },
            span.italic && { fontStyle: "italic" },
            span.strike && { textDecorationLine: "line-through" },
            span.code && { fontFamily: "monospace", backgroundColor: codeBackground },
            span.link && { color: linkColor, textDecorationLine: "underline" },
            span.mention && { color: linkColor, fontWeight: "600" },
          ]}
        >
          {span.text}
        </Text>
      ))}
    </Text>
  );
}

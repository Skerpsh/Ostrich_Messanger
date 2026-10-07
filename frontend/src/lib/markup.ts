// Text formatting in messages, written like Markdown and kept in the
// encrypted text: **bold**, *italic* or _italic_, ~~strikethrough~~,
// `code`, ```code block```; links are found by themselves. The CLI draws
// the same (cli/markup.go).

export type Span = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  // The address, for links.
  link?: string;
};

type Style = Omit<Span, "text">;

// `lead`: the pattern starts with a group for the character before the
// marker (instead of a lookbehind, which not every JavaScript engine has);
// the formatted part starts after it.
type Rule = {
  re: RegExp;
  style: (match: RegExpExecArray) => Style;
  inner: boolean;
  lead?: boolean;
};

const RULES: Rule[] = [
  { re: /```\n?([\s\S]+?)\n?```/, style: () => ({ code: true }), inner: false },
  { re: /`([^`\n]+)`/, style: () => ({ code: true }), inner: false },
  { re: /\*\*(?=\S)([\s\S]*?\S)\*\*/, style: () => ({ bold: true }), inner: true },
  { re: /~~(?=\S)([\s\S]*?\S)~~/, style: () => ({ strike: true }), inner: true },
  {
    re: /(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/,
    style: () => ({ italic: true }),
    inner: true,
    lead: true,
  },
  {
    re: /(^|[^\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/,
    style: () => ({ italic: true }),
    inner: true,
    lead: true,
  },
  {
    re: /\bhttps?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]}'"]/i,
    style: (match) => ({ link: match[0] }),
    inner: false,
  },
];

// The formatted parts of a text, in order; joined they give the text
// without the markers.
export function parseMarkup(text: string, style: Style = {}): Span[] {
  const spans: Span[] = [];
  let rest = text;

  while (rest) {
    let best: { rule: Rule; match: RegExpExecArray } | null = null;

    for (const rule of RULES) {
      const match = rule.re.exec(rest);

      if (match && rule.lead) {
        // Skip the character before the marker.
        match.index += match[1].length;
        match[0] = match[0].slice(match[1].length);
        match.splice(1, 1);
      }

      if (match && (!best || match.index < best.match.index)) {
        best = { rule, match };
      }
    }

    if (!best) {
      spans.push({ text: rest, ...style });
      break;
    }

    const { rule, match } = best;

    if (match.index > 0) {
      spans.push({ text: rest.slice(0, match.index), ...style });
    }

    const inner = rule.style(match);
    const content = inner.link ? match[0] : match[1];

    if (rule.inner && !style.code) {
      spans.push(...parseMarkup(content, { ...style, ...inner }));
    } else {
      spans.push({ text: content, ...style, ...inner });
    }

    rest = rest.slice(match.index + match[0].length);
  }

  return spans;
}

// The text without the markers, for previews and notifications.
export function plainText(text: string) {
  return parseMarkup(text)
    .map((span) => span.text)
    .join("");
}

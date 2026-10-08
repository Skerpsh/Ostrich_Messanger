import { getItem, setItem } from "./storage";

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

// One emoji per character; those that are text by default (☀, ✈) get the
// emoji variation selector.
function split(text: string) {
  return [...graphemes.segment(text)]
    .map(({ segment }) => segment)
    .map((emoji) => ([...emoji].length === 1 && emoji.codePointAt(0)! < 0x1f000 ? `${emoji}\uFE0F` : emoji));
}

// The emoji offered in the picker (components/emoji-picker.tsx), by
// category; any emoji can also be typed.
export const EMOJI_CATEGORIES: { name: string; icon: string; emoji: string[] }[] = [
  {
    name: "Smileys",
    icon: "😀",
    emoji: split("😀😃😄😁😆😅🤣😂🙂🙃😉😊😇🥰😍🤩😘😗😚😙😋😛😜🤪😝🤑🤗🤭🤫🤔🤐🤨😐😑😶😏😒🙄😬🤥😌😔😪🤤😴😷🤒🤕🤢🤮🥵🥶🥴😵🤯🤠🥳😎🤓🧐😕😟🙁😮😯😲😳🥺😦😧😨😰😥😢😭😱😖😣😞😓😩😫🥱😤😡😠🤬😈👿💀💩🤡👻👽🤖😺😸😹😻😼😽🙀😿😾"),
  },
  {
    name: "People",
    icon: "👋",
    emoji: [
      ..."👋🤚🖐✋🖖👌🤌🤏✌🤞🤟🤘🤙👈👉👆👇☝👍👎✊👊🤛🤜👏🙌👐🤲🤝🙏✍💅🤳💪🦾🦵🦶👂🦻👃🧠🦷🦴👀👁👅👄💋🩸👶🧒👦👧🧑👱👨🧔👩🧓👴👵🙍🙎🙅🙆💁🙋🧏🙇🤦🤷👮🕵💂🥷👷🤴👸👳👲🧕🤵👰🤰🤱👼🎅🤶🦸🦹🧙🧚🧛🧜🧝🧞🧟💆💇🚶🧍🧎🏃💃🕺👯🧖🧗🤺🏇⛷🏂🏌🏄🚣🏊⛹🏋🚴🚵🤸🤼🤽🤾🤹🧘🛀🛌👭👫👬💏💑👪",
    ].filter((e) => e !== "️"),
  },
  {
    name: "Hearts",
    icon: "❤️",
    emoji: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🤎", "🖤", "🤍", "💔", "❣️", "💕", "💞", "💓", "💗", "💖", "💘", "💝", "💟", "♥️", "💯", "💢", "💥", "💫", "💦", "💨", "🕳️", "💬", "💭", "💤"],
  },
  {
    name: "Animals",
    icon: "🐶",
    emoji: split("🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮🐷🐸🐵🙈🙉🙊🐒🐔🐧🐦🐤🦆🦅🦉🦇🐺🐗🐴🦄🐝🐛🦋🐌🐞🐜🦟🦗🕷🦂🐢🐍🦎🦖🦕🐙🦑🦐🦞🦀🐡🐠🐟🐬🐳🐋🦈🐊🐅🐆🦓🦍🦧🐘🦛🦏🐪🐫🦒🦘🐃🐂🐄🐎🐖🐏🐑🦙🐐🦌🐕🐩🦮🐈🐓🦃🦚🦜🦢🦩🕊🐇🦝🦨🦡🦦🦥🐁🐀🐿🦔🐾🐉🐲🦤🌵🎄🌲🌳🌴🌱🌿☘🍀🎍🎋🍃🍂🍁🍄🐚🌾💐🌷🌹🥀🌺🌸🌼🌻🌞🌝🌛🌜🌚🌕🌖🌗🌘🌑🌒🌓🌔🌙🌎🌍🌏🪐💫⭐🌟✨⚡☄💥🔥🌪🌈☀🌤⛅🌥☁🌦🌧⛈🌩🌨❄☃⛄🌬💨💧💦☔☂🌊🌫").filter((e) => e !== "️"),
  },
  {
    name: "Food",
    icon: "🍕",
    emoji: split("🍏🍎🍐🍊🍋🍌🍉🍇🍓🫐🍈🍒🍑🥭🍍🥥🥝🍅🍆🥑🥦🥬🥒🌶🌽🥕🧄🧅🥔🍠🥐🥯🍞🥖🥨🧀🥚🍳🧈🥞🧇🥓🥩🍗🍖🌭🍔🍟🍕🥪🥙🧆🌮🌯🥗🥘🥫🍝🍜🍲🍛🍣🍱🥟🦪🍤🍙🍚🍘🍥🥠🥮🍢🍡🍧🍨🍦🥧🧁🍰🎂🍮🍭🍬🍫🍿🍩🍪🌰🥜🍯🥛🍼☕🍵🧃🥤🍶🍺🍻🥂🍷🥃🍸🍹🧉🍾🧊🥄🍴🍽🥣🥡🥢").filter((e) => e !== "️"),
  },
  {
    name: "Activities",
    icon: "⚽",
    emoji: split("⚽🏀🏈⚾🥎🎾🏐🏉🥏🎱🪀🏓🏸🏒🏑🥍🏏🥅⛳🪁🏹🎣🤿🥊🥋🎽🛹🛼🛷⛸🥌🎿🎯🎮🕹🎲🧩♟🎭🎨🧵🧶🎼🎤🎧🎷🎸🎹🎺🎻🥁🎬🏆🥇🥈🥉🏅🎖🎗🎫🎟🎪🎉🎊🎈🎁🎀🎃🎆🎇🧨").filter((e) => e !== "️"),
  },
  {
    name: "Travel",
    icon: "✈️",
    emoji: split("🚗🚕🚙🚌🚎🏎🚓🚑🚒🚐🚚🚛🚜🛴🚲🛵🏍🚨🚔🚍🚘🚖🚡🚠🚟🚃🚋🚞🚝🚄🚅🚈🚂🚆🚇🚊🚉✈🛫🛬🛩💺🛰🚀🛸🚁🛶⛵🚤🛥🛳⛴🚢⚓⛽🚧🚦🚥🗺🗿🗽🗼🏰🏯🏟🎡🎢🎠⛲⛱🏖🏝🏜🌋⛰🏔🗻🏕⛺🏠🏡🏘🏚🏗🏭🏢🏬🏣🏤🏥🏦🏨🏪🏫🏩💒🏛⛪🕌🕍🛕🕋⛩🌅🌄🌠🎇🎆🌇🌆🏙🌃🌌🌉🌁").filter((e) => e !== "️"),
  },
  {
    name: "Objects",
    icon: "💡",
    emoji: split("⌚📱💻⌨🖥🖨🖱🕹💽💾💿📀📷📸📹🎥📞☎📺📻🎙⏰⌛⏳📡🔋🔌💡🔦🕯🧯💸💵💴💶💷💰💳💎⚖🧰🔧🔨⚒🛠⛏🔩⚙🧱⛓🧲🔫💣🧨🔪🗡⚔🛡🚬⚰🔮📿🧿💈⚗🔭🔬🩹🩺💊💉🧬🦠🧫🧪🌡🧹🧺🧻🚽🚰🚿🛁🧼🪒🧽🧴🛎🔑🗝🚪🪑🛋🛏🧸🖼🛍🛒🎁🎈🎏🎀🎊🎉✉📩📨📧💌📥📤📦🏷📪📫📬📭📮📯📜📃📄📑🧾📊📈📉🗒🗓📆📅🗑📇🗃🗳🗄📋📁📂🗂🗞📰📓📔📒📕📗📘📙📚📖🔖🧷🔗📎🖇📐📏🧮📌📍✂🖊🖋✒🖌🖍📝✏🔍🔎🔏🔐🔒🔓").filter((e) => e !== "️"),
  },
  {
    name: "Symbols",
    icon: "✅",
    emoji: ["✅", "☑️", "✔️", "❌", "❎", "➕", "➖", "➗", "✖️", "♾️", "‼️", "⁉️", "❓", "❔", "❕", "❗", "〰️", "⚠️", "🚫", "⛔", "📛", "🔞", "♻️", "🔰", "⭕", "🆗", "🆕", "🆒", "🆓", "🆙", "🆘", "🔝", "🔜", "🔙", "🔛", "🔚", "▶️", "⏸️", "⏹️", "⏺️", "⏭️", "⏮️", "⏩", "⏪", "🔀", "🔁", "🔂", "🔼", "🔽", "➡️", "⬅️", "⬆️", "⬇️", "↗️", "↘️", "↙️", "↖️", "↕️", "↔️", "🔄", "🎵", "🎶", "💲", "©️", "®️", "™️", "🔔", "🔕", "📣", "📢", "🔈", "🔇", "🔉", "🔊", "🏁", "🚩", "🏳️", "🏴", "🏳️‍🌈", "🇺🇦", "🇺🇸", "🇬🇧", "🇩🇪", "🇫🇷", "🇪🇸", "🇮🇹", "🇵🇱", "🇯🇵", "🇨🇦"],
  },
];

// The emoji picked last, first in the picker (on this device).
const RECENT_KEY = "ostrich-recent-emoji";
const RECENT = 24;

export async function recentEmoji(): Promise<string[]> {
  try {
    const saved = JSON.parse((await getItem(RECENT_KEY)) ?? "[]");
    return Array.isArray(saved) ? saved.filter((e) => typeof e === "string").slice(0, RECENT) : [];
  } catch {
    return [];
  }
}

export async function rememberEmoji(emoji: string) {
  const recent = await recentEmoji();
  await setItem(RECENT_KEY, JSON.stringify([emoji, ...recent.filter((e) => e !== emoji)].slice(0, RECENT)));
}

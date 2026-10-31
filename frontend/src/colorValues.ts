export const legacyColors: Record<string, string> = {
  red: "#d64545",
  grey: "#7b8790",
  "light-blue": "#6ba8d2",
  "dark-blue": "#234e70",
  green: "#2f9e6b",
  orange: "#e68a2e",
  purple: "#8b5fbf",
  teal: "#229c9c",
  yellow: "#d6ad28",
  pink: "#d45a91",
  navy: "#142b40",
  brown: "#8a5a3b",
};

export function normalizeColor(value: string): string | null {
  const color = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(color)) return color;
  if (/^#[0-9a-f]{3}$/.test(color))
    return "#" + [...color.slice(1)].map((c) => c + c).join("");
  return Object.hasOwn(legacyColors, color) ? legacyColors[color] : null;
}

export function colorToRgb(color: string): [number, number, number] {
  const hex = normalizeColor(color) || "#234e70";
  return [1, 3, 5].map((offset) =>
    parseInt(hex.slice(offset, offset + 2), 16),
  ) as [number, number, number];
}

export function rgbToColor(values: number[]): string | null {
  if (
    values.length !== 3 ||
    values.some((v) => !Number.isInteger(v) || v < 0 || v > 255)
  )
    return null;
  return "#" + values.map((v) => v.toString(16).padStart(2, "0")).join("");
}

const namePalette = [
  "#1769aa",
  "#8e3b76",
  "#26734d",
  "#a34f00",
  "#5a45a8",
  "#a12f3f",
  "#006d77",
  "#7a4e00",
];
export function chatNameColor(
  id: string,
  colors: Record<string, string> = {},
): string {
  return (
    normalizeColor(colors[id] || "") ||
    namePalette[
      [...id].reduce((sum, c) => sum + c.charCodeAt(0), 0) % namePalette.length
    ]
  );
}

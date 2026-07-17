export function primaryModifierForPlatform(platform: string) {
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? "⌘" : "Ctrl";
}

export function primaryModifier() {
  if (typeof navigator === "undefined") return "Ctrl";
  return primaryModifierForPlatform(navigator.platform || navigator.userAgent);
}

export function formatShortcut(shortcut: string) {
  return shortcut.replaceAll("⌘", primaryModifier());
}

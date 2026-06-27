import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

const THEME_STORAGE_KEY = "rulix-site-theme";

export type ThemeMode = "light" | "dark";

export function getInitialTheme(): ThemeMode {
  if (typeof window === "undefined") {
    return "dark";
  }

  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") {
    return stored;
  }

  return "dark";
}

export function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.classList.toggle("theme-dark", mode === "dark");
  root.classList.toggle("theme-light", mode === "light");

  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColor) {
    themeColor.content = mode === "dark" ? "#05080a" : "#f7fafc";
  }
}

export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>(() => getInitialTheme());
  const nextMode = mode === "dark" ? "light" : "dark";

  useEffect(() => {
    applyTheme(mode);
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  }, [mode]);

  return (
    <button
      className="theme-toggle"
      type="button"
      aria-label={`Switch to ${nextMode} mode`}
      title={`Switch to ${nextMode} mode`}
      onClick={() => setMode(nextMode)}
    >
      {mode === "dark" ? <Sun size={15} /> : <Moon size={15} />}
      <span>{mode === "dark" ? "Light" : "Dark"}</span>
    </button>
  );
}

import { useEffect, useState } from "preact/hooks";

/**
 * Theme state. Three user-facing modes; `system` follows the OS and re-resolves
 * live when the OS flips. The resolved value is stamped on <html> as
 * `data-theme`, which is what style.css keys the palette off — see the token
 * block there for how one attribute repaints the whole app.
 */
export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_LS_KEY = "xerxes.theme";

/** Kept in sync with `--x-page` in style.css — drives the browser chrome colour. */
const PAGE_COLOR: Record<ResolvedTheme, string> = { dark: "#0a0e14", light: "#f6f8fb" };

const MODES: ThemeMode[] = ["system", "light", "dark"];
const isMode = (v: unknown): v is ThemeMode => MODES.includes(v as ThemeMode);

const darkQuery = () =>
  typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

export function readMode(): ThemeMode {
  try {
    const s = localStorage.getItem(THEME_LS_KEY);
    if (isMode(s)) return s;
  } catch {
    /* private mode / storage disabled — fall through to the default */
  }
  return "system";
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode !== "system") return mode;
  return darkQuery()?.matches === false ? "light" : "dark";
}

/** Stamp the resolved theme on <html>. Safe to call before the app mounts. */
export function applyTheme(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", PAGE_COLOR[resolved]);
  return resolved;
}

const nextMode = (m: ThemeMode): ThemeMode => MODES[(MODES.indexOf(m) + 1) % MODES.length];

export const MODE_ICON: Record<ThemeMode, string> = { system: "◐", light: "☀", dark: "☾" };
export const MODE_LABEL: Record<ThemeMode, string> = { system: "System", light: "Light", dark: "Dark" };

// Every mounted toggle shares one mode so they can't drift apart.
const listeners = new Set<(m: ThemeMode) => void>();
let current: ThemeMode = "system";
let initialised = false;

export function setMode(mode: ThemeMode) {
  current = mode;
  try {
    localStorage.setItem(THEME_LS_KEY, mode);
  } catch {
    /* not persisting is survivable — the session still themes correctly */
  }
  applyTheme(mode);
  for (const fn of listeners) fn(mode);
}

/** Advance system → light → dark. Reads the module-level mode rather than a
 *  rendered one, so a fast double-tap advances two steps instead of one. */
export const cycleMode = () => setMode(nextMode(current));

/** Current mode + a setter. Re-renders on OS changes while in `system` mode. */
export function useTheme(): { mode: ThemeMode; resolved: ResolvedTheme; setMode: (m: ThemeMode) => void } {
  if (!initialised) {
    current = readMode();
    initialised = true;
  }
  const [mode, setLocal] = useState<ThemeMode>(current);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(current));

  useEffect(() => {
    const onMode = (m: ThemeMode) => {
      setLocal(m);
      setResolved(resolveTheme(m));
    };
    listeners.add(onMode);
    return () => void listeners.delete(onMode);
  }, []);

  // Follow the OS while on `system`; a fixed choice ignores it.
  useEffect(() => {
    if (mode !== "system") return;
    const mq = darkQuery();
    if (!mq) return;
    const onChange = () => setResolved(applyTheme("system"));
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode]);

  return { mode, resolved, setMode };
}

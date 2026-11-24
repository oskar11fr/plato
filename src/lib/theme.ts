// Light ("Paper") or dark ("Night study"); "system" follows the OS setting.
// The choice is a per-device convenience, so it lives in localStorage.
export type ThemePref = "system" | "light" | "dark";

const KEY = "plato.theme";

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

/** Set `data-theme` on <html>; without it the CSS follows the OS. */
export function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === "system") delete root.dataset.theme;
  else root.dataset.theme = pref;
}

export function setThemePref(pref: ThemePref) {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {}
  applyTheme(pref);
}

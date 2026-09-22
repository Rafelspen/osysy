// Registry of dashboard visual themes. Pure data, no server imports, so it can be
// read from the layout (to render the switcher and the anti-flash init script)
// and from the switcher component itself.
//
// To add a theme: give it an id, a label, a body class, and a small CSS file
// scoped to that class (see hydro-theme.css), imported in layout.tsx. "classic"
// is the original plain look and needs no CSS of its own — bodyClass "" means
// "no extra styling".

export type ThemeId = "hydro" | "tidal" | "classic";

export type ThemeMeta = {
  id: ThemeId;
  label: string;
  bodyClass: string;
  swatch: string; // small CSS background for the picker's preview dot
};

export const THEMES: ThemeMeta[] = [
  { id: "hydro", label: "Hydro Glass", bodyClass: "hydro", swatch: "linear-gradient(135deg, #00e5ff, #021a2b)" },
  { id: "tidal", label: "Deep Current", bodyClass: "tidal", swatch: "linear-gradient(135deg, #22e0ff, #6a6bff 55%, #04202a)" },
  { id: "classic", label: "Classic (light)", bodyClass: "", swatch: "linear-gradient(135deg, #ffffff, #cbd5e1)" },
];

export const DEFAULT_THEME: ThemeId = "hydro";
export const THEME_STORAGE_KEY = "obsys.theme.v1";
export const KNOWN_BODY_CLASSES = THEMES.map((t) => t.bodyClass).filter(Boolean);

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === "string" && THEMES.some((t) => t.id === v);
}

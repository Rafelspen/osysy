"use client";

// Header control to pick the dashboard's visual theme. Applying a theme only
// toggles a class on <body> (see themes.ts) and remembers the choice in
// localStorage; layout.tsx's inline script applies that choice on the next
// load before paint, so there's no flash of the wrong theme.

import { useEffect, useRef, useState } from "react";
import { DEFAULT_THEME, isThemeId, KNOWN_BODY_CLASSES, THEME_STORAGE_KEY, THEMES, type ThemeId } from "@/lib/themes";

function applyTheme(id: ThemeId) {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!;
  for (const cls of KNOWN_BODY_CLASSES) document.body.classList.remove(cls);
  if (theme.bodyClass) document.body.classList.add(theme.bodyClass);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme.id);
  } catch {
    // storage unavailable (private window, blocked) — the pick just won't be remembered
  }
}

export default function ThemeSwitcher() {
  const [current, setCurrent] = useState<ThemeId>(DEFAULT_THEME);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Read what the anti-flash script already applied, so the button shows the
  // right label from the first render that matters (no need to guess).
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      stored = null;
    }
    setCurrent(isThemeId(stored) ? stored : DEFAULT_THEME);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function choose(id: ThemeId) {
    applyTheme(id);
    setCurrent(id);
    setOpen(false);
  }

  const currentTheme = THEMES.find((t) => t.id === current) ?? THEMES[0];

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Change the dashboard's look"
        className="flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
      >
        <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: currentTheme.swatch }} />
        Theme: {currentTheme.label}
      </button>
      {open && (
        <div role="menu" aria-label="Choose a theme" className="absolute right-0 z-40 mt-1 w-48 rounded-md border border-slate-200 bg-white p-1 shadow-lg">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitemradio"
              aria-checked={t.id === current}
              onClick={() => choose(t.id)}
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${
                t.id === current ? "bg-slate-100 font-medium text-slate-900" : "text-slate-700 hover:bg-slate-50"
              }`}
            >
              <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: t.swatch }} />
              {t.label}
              {t.id === current && <span className="ml-auto">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import Script from "next/script";
import "./globals.css";
import "./hydro-theme.css";
import "./tidal-theme.css";
import "./abyss-theme.css";
import "./holo-theme.css";
import "./biolume-theme.css";
import NavLinks from "./NavLinks";
import ThemeSwitcher from "./ThemeSwitcher";
import { DEFAULT_THEME, KNOWN_BODY_CLASSES, THEME_STORAGE_KEY, THEMES } from "@/lib/themes";

export const metadata: Metadata = {
  title: "obsys",
  description: "Control room for the automated cold-outreach pipeline",
};

const DEFAULT_BODY_CLASS = THEMES.find((t) => t.id === DEFAULT_THEME)?.bodyClass ?? "";

// Applies a remembered theme choice to <body> before the page paints, so a
// visitor who picked "Classic" never sees a flash of the Hydro Glass theme (or
// vice versa). Runs once per load; body starts with the default theme's class
// (below) for the common case and for anyone without JavaScript.
const THEME_INIT_SCRIPT = `(function(){try{
  var KEY=${JSON.stringify(THEME_STORAGE_KEY)};
  var MAP=${JSON.stringify(Object.fromEntries(THEMES.map((t) => [t.id, t.bodyClass])))};
  var KNOWN=${JSON.stringify(KNOWN_BODY_CLASSES)};
  var v=localStorage.getItem(KEY);
  if(v && Object.prototype.hasOwnProperty.call(MAP,v)){
    for(var i=0;i<KNOWN.length;i++){document.body.classList.remove(KNOWN[i]);}
    if(MAP[v]){document.body.classList.add(MAP[v]);}
  }
}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={DEFAULT_BODY_CLASS} suppressHydrationWarning>
        <Script id="theme-init" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <div className="min-h-screen">
          {/* relative + z-30: without its own stacking context, this header (and the
              Theme dropdown inside it) would paint behind any positioned descendant
              elsewhere on the page — e.g. the dashboard's `sticky` side panel — no
              matter what z-index the dropdown itself has. */}
          <header className="relative z-30 border-b border-slate-200 bg-white">
            <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
              <span className="flex items-center gap-2 font-semibold text-slate-900">
                <span aria-hidden className="brand-orb" />
                obsys
              </span>
              <nav className="flex items-center gap-4 text-sm">
                <NavLinks />
                <ThemeSwitcher />
              </nav>
            </div>
          </header>
          <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
          <footer className="mx-auto max-w-7xl px-6 pb-8 text-xs text-slate-400">
            <Link href="/privacy" className="hover:text-slate-600">
              Privacy Policy
            </Link>
            <span className="mx-2">·</span>
            <Link href="/terms" className="hover:text-slate-600">
              Terms of Service
            </Link>
          </footer>
        </div>
      </body>
    </html>
  );
}

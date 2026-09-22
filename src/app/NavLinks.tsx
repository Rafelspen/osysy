"use client";

// The header nav links, marking which page is current (aria-current="page").
// Themes may style that marker (see .nav-link[aria-current="page"] in a
// theme's CSS); a theme that doesn't style it just shows a plain link, so this
// is safe to share across every theme.

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/add-lead", label: "Add Lead" },
  { href: "/templates", label: "Templates" },
  { href: "/connect", label: "Connect" },
];

export default function NavLinks() {
  const pathname = usePathname();
  return (
    <>
      {NAV_ITEMS.map((item) => {
        const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className="nav-link text-slate-600 hover:text-slate-900"
          >
            {item.label}
          </Link>
        );
      })}
    </>
  );
}

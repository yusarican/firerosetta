import Link from "next/link";
import { BellRing } from "lucide-react";

export function AppHeader({ active }: { active: "calendar" | "risk" | "method" }) {
  const links = [
    { id: "calendar", href: "/", label: "Calendar" },
    { id: "risk", href: "/risk", label: "Early Warning" },
    { id: "method", href: "/method", label: "How it works" },
  ];
  return (
    <header className="mb-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-4 border-b py-5">
      <div>
        <Link href="/" className="display text-xl">FireRosetta</Link>
        <p className="mt-0.5 text-xs text-muted-foreground">MODIS + VIIRS · one fire record</p>
      </div>
      <nav aria-label="Main navigation" className="flex flex-wrap items-center gap-1 text-sm">
        {links.map((link) => (
          <Link key={link.id} href={link.href} aria-current={active === link.id ? "page" : undefined}
            className={`inline-flex min-h-10 items-center gap-2 rounded-md px-3 py-2 transition-colors ${active === link.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}>
            {link.id === "risk" && <BellRing className="size-4" aria-hidden="true" />}
            {link.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

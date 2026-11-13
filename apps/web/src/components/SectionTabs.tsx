import Link from 'next/link';

/** v0.18.0 (C4): two views of one section under More: Reports and History,
 *  Rules and Levels by turn. Plain links, so each view keeps its address. */
export function SectionTabs({
  items,
  current,
  label,
}: {
  items: { href: string; label: string }[];
  current: string;
  label: string;
}) {
  return (
    <nav aria-label={label} className="flex flex-wrap gap-2 border-b-2 border-pumice pb-2">
      {items.map((i) => (
        <Link
          key={i.href}
          href={i.href}
          aria-current={i.href === current ? 'page' : undefined}
          className={`inline-flex min-h-11 items-center rounded-control px-4 font-semibold ${
            i.href === current ? 'bg-slate text-board' : 'border-2 border-slate/30 text-slate'
          }`}
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

"use client";

import Link from "next/link";
import type { MindshareBar } from "@/app/lib/mindspace/share-bar";

export function MindspaceBar({
  bar,
  animate,
}: {
  bar: MindshareBar;
  animate: boolean;
}) {
  const remainder = 1 - bar.segments.reduce((sum, seg) => sum + seg.share, 0);
  return (
    <Link
      href="/mindspace"
      aria-label="mindspace attention"
      className="press block py-2 -my-1"
    >
      <div
        className="flex h-1.5 rounded-full overflow-hidden ring-1 ring-hairline"
        aria-hidden
      >
        {bar.segments.map((seg, index) => (
          <div
            key={seg.topicId}
            className={animate ? "bar-grow" : undefined}
            style={{
              width: `${seg.share * 100}%`,
              backgroundColor: seg.color,
              animationDelay: animate
                ? `${Math.min(index, 8) * 50}ms`
                : undefined,
            }}
          />
        ))}
        {remainder > 0 && (
          <div className="bg-card" style={{ width: `${remainder * 100}%` }} />
        )}
      </div>
    </Link>
  );
}

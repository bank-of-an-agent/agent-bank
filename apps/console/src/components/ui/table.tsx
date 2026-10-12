import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Data tables scroll horizontally on narrow screens inside a focusable,
 * labelled region, so keyboard users can scroll them too.
 */
export function Table({
  caption,
  children,
  className,
  captionVisible = false,
}: {
  caption: string;
  children: ReactNode;
  className?: string;
  captionVisible?: boolean;
}) {
  return (
    // `relative` keeps absolutely positioned descendants (sr-only labels) inside the scroll box,
    // so a wide table never widens the page on small screens.
    <div
      role="region"
      aria-label={caption}
      tabIndex={0}
      className={cn("relative overflow-x-auto", className)}
    >
      <table className="w-full border-collapse text-left text-sm">
        <caption className={captionVisible ? "pb-2 text-left text-sm text-muted" : "sr-only"}>
          {caption}
        </caption>
        {children}
      </table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead className="border-b border-line bg-subtle text-xs uppercase tracking-wide text-muted">
      {children}
    </thead>
  );
}

export function Th({ className, align, ...props }: ComponentProps<"th"> & { align?: "left" | "right" }) {
  return (
    <th
      scope="col"
      className={cn(
        "px-4 py-2.5 font-semibold whitespace-nowrap",
        align === "right" && "text-right",
        className,
      )}
      {...props}
    />
  );
}

export function Tr({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr className={cn("border-b border-line last:border-b-0 hover:bg-subtle/60", className)} {...props} />
  );
}

export function Td({ className, align, ...props }: ComponentProps<"td"> & { align?: "left" | "right" }) {
  return (
    <td
      className={cn("px-4 py-3 align-top", align === "right" && "text-right tabular", className)}
      {...props}
    />
  );
}

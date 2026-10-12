"use client";

import { useEffect, useSyncExternalStore } from "react";
import { IconMonitor, IconMoon, IconSun } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { applyPreference, readPreference, type ThemePreference } from "@/lib/theme";

const OPTIONS: { value: ThemePreference; label: string; icon: typeof IconSun }[] = [
  { value: "system", label: "System theme", icon: IconMonitor },
  { value: "light", label: "Light theme", icon: IconSun },
  { value: "dark", label: "Dark theme", icon: IconMoon },
];

const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** System / light / dark as toggle buttons. The initial theme is set before paint by the head script. */
export function ThemeToggle({ className }: { className?: string }) {
  const preference = useSyncExternalStore(subscribe, readPreference, () => "system" as ThemePreference);

  // Follow the OS setting while the preference is "system".
  useEffect(() => {
    if (preference !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyPreference("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [preference]);

  function choose(value: ThemePreference) {
    applyPreference(value);
    listeners.forEach((l) => l());
  }

  return (
    <div
      role="group"
      aria-label="Color theme"
      className={cn("inline-flex rounded-lg border border-line bg-subtle p-0.5", className)}
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => {
        const checked = preference === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={checked}
            aria-label={label}
            title={label}
            onClick={() => choose(value)}
            className={cn(
              "rounded-md p-1.5 transition-colors",
              checked ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg",
            )}
          >
            <Icon size={15} />
          </button>
        );
      })}
    </div>
  );
}

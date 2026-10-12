"use client";

import { useId } from "react";
import { inputClasses } from "@/components/ui/field";
import { cn } from "@/lib/cn";

/**
 * JSON view of the policy draft. The text is the source of truth while it is
 * being edited; the parent parses it and validates it with
 * `PolicyDocumentSchema` on every change.
 */
export function PolicyJsonEditor({
  value,
  onChange,
  syntaxError,
}: {
  value: string;
  onChange: (text: string) => void;
  syntaxError: string | null;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium">
        Policy document (JSON)
      </label>
      <p id={`${id}-hint`} className="text-xs text-muted">
        Validated live against <code className="font-mono">PolicyDocumentSchema</code> and the policy engine.
        Amounts are decimal strings, never numbers.
      </p>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        rows={24}
        aria-invalid={syntaxError ? true : undefined}
        aria-describedby={`${id}-hint${syntaxError ? ` ${id}-error` : ""}`}
        className={cn(inputClasses, "min-h-[24rem] py-3 font-mono text-xs leading-relaxed")}
      />
      {syntaxError ? (
        <p id={`${id}-error`} role="alert" className="text-xs font-medium text-danger-fg">
          JSON syntax error: {syntaxError}
        </p>
      ) : null}
    </div>
  );
}

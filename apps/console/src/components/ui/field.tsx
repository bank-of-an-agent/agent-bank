"use client";

import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export const inputClasses =
  "block w-full rounded-lg border border-field bg-surface px-3 text-sm text-fg placeholder:text-muted " +
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring " +
  "disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger";

interface FieldChromeProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  className?: string;
  /** Visually hide the label (it stays available to assistive technology). */
  hideLabel?: boolean;
}

function FieldChrome({
  id,
  label,
  hint,
  error,
  required,
  className,
  hideLabel,
  children,
}: FieldChromeProps & { id: string; children: ReactNode }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className={cn("block text-sm font-medium text-fg", hideLabel && "sr-only")}>
        {label}
        {required ? (
          <span className="text-danger-fg" aria-hidden="true">
            {" "}
            *
          </span>
        ) : null}
      </label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-xs font-medium text-danger-fg">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, hint: unknown, error: unknown): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}

export function TextField({
  label,
  hint,
  error,
  required,
  className,
  hideLabel,
  id: idProp,
  inputClassName,
  ...props
}: FieldChromeProps & Omit<ComponentProps<"input">, "className"> & { inputClassName?: string }) {
  const generated = useId();
  const id = idProp ?? generated;
  return (
    <FieldChrome
      id={id}
      label={label}
      hint={hint}
      error={error}
      required={required}
      className={className}
      hideLabel={hideLabel}
    >
      <input
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cn(inputClasses, "h-10", inputClassName)}
        {...props}
      />
    </FieldChrome>
  );
}

export function TextAreaField({
  label,
  hint,
  error,
  required,
  className,
  hideLabel,
  id: idProp,
  inputClassName,
  ...props
}: FieldChromeProps & Omit<ComponentProps<"textarea">, "className"> & { inputClassName?: string }) {
  const generated = useId();
  const id = idProp ?? generated;
  return (
    <FieldChrome
      id={id}
      label={label}
      hint={hint}
      error={error}
      required={required}
      className={className}
      hideLabel={hideLabel}
    >
      <textarea
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cn(inputClasses, "py-2", inputClassName)}
        {...props}
      />
    </FieldChrome>
  );
}

export function SelectField({
  label,
  hint,
  error,
  required,
  className,
  hideLabel,
  id: idProp,
  children,
  ...props
}: FieldChromeProps & Omit<ComponentProps<"select">, "className">) {
  const generated = useId();
  const id = idProp ?? generated;
  return (
    <FieldChrome
      id={id}
      label={label}
      hint={hint}
      error={error}
      required={required}
      className={className}
      hideLabel={hideLabel}
    >
      <select
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cn(inputClasses, "h-10 pr-8")}
        {...props}
      >
        {children}
      </select>
    </FieldChrome>
  );
}

export function Checkbox({
  label,
  hint,
  className,
  ...props
}: { label: ReactNode; hint?: ReactNode; className?: string } & Omit<
  ComponentProps<"input">,
  "type" | "className"
>) {
  const id = useId();
  return (
    <div className={cn("flex items-start gap-2", className)}>
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-4 rounded border-field accent-primary"
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...props}
      />
      <div>
        <label htmlFor={id} className="text-sm text-fg">
          {label}
        </label>
        {hint ? (
          <p id={`${id}-hint`} className="text-xs text-muted">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

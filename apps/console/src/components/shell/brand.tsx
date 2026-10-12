import { useId } from "react";
import { cn } from "@/lib/cn";

/**
 * The Agent Bank mark (vault dial with a keyhole; the three nodes are the
 * owner key in amber, the session key in teal and the co-signer in violet),
 * inlined so it needs no image request and gets unique gradient ids.
 */
export function BrandMark({
  size = 28,
  className,
  title,
}: {
  size?: number;
  className?: string;
  title?: string;
}) {
  const id = useId().replace(/:/g, "");
  return (
    <svg
      viewBox="0 0 512 512"
      width={size}
      height={size}
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#13203F" />
          <stop offset="1" stopColor="#070B16" />
        </linearGradient>
        <linearGradient id={`${id}-ring`} x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0" stopColor="#5B8CFF" />
          <stop offset="1" stopColor="#2DD4BF" />
        </linearGradient>
        <radialGradient id={`${id}-glow`} cx="0.5" cy="0.45" r="0.55">
          <stop offset="0" stopColor="#4C7DFF" stopOpacity="0.35" />
          <stop offset="1" stopColor="#4C7DFF" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="512" height="512" rx="116" fill={`url(#${id}-bg)`} />
      <rect width="512" height="512" rx="116" fill={`url(#${id}-glow)`} />
      <rect
        x="5"
        y="5"
        width="502"
        height="502"
        rx="111"
        fill="none"
        stroke="#FFFFFF"
        strokeOpacity="0.08"
        strokeWidth="3"
      />
      <g stroke="#FFFFFF" strokeOpacity="0.16" strokeWidth="6" strokeLinecap="round">
        <line x1="256" y1="152" x2="256" y2="166" />
        <line x1="346" y1="204" x2="334" y2="211" />
        <line x1="346" y1="308" x2="334" y2="301" />
        <line x1="256" y1="360" x2="256" y2="346" />
        <line x1="166" y1="308" x2="178" y2="301" />
        <line x1="166" y1="204" x2="178" y2="211" />
      </g>
      <circle cx="256" cy="256" r="150" fill="none" stroke={`url(#${id}-ring)`} strokeWidth="30" />
      <circle cx="256" cy="236" r="40" fill="#EEF2FA" />
      <path d="M236 262 H276 L290 322 Q292 332 282 332 H230 Q220 332 222 322 Z" fill="#EEF2FA" />
      <circle cx="256" cy="106" r="27" fill="#F5B947" stroke="#0A1022" strokeWidth="10" />
      <circle cx="385.9" cy="331" r="27" fill="#2DD4BF" stroke="#0A1022" strokeWidth="10" />
      <circle cx="126.1" cy="331" r="27" fill="#A78BFA" stroke="#0A1022" strokeWidth="10" />
    </svg>
  );
}

export function BrandLockup({ className, subtitle = "Console" }: { className?: string; subtitle?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <BrandMark size={30} />
      <span className="flex flex-col leading-tight">
        <span className="text-[15px] font-semibold tracking-tight text-fg">Agent Bank</span>
        <span className="text-xs text-muted">{subtitle}</span>
      </span>
    </span>
  );
}

import type { SVGProps } from "react";

/** Small stroke icons (24×24 grid). Decorative by default: pass `aria-label` to make one meaningful. */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...props }: IconProps & { children: React.ReactNode }) {
  const labelled = props["aria-label"] !== undefined;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={labelled ? undefined : true}
      role={labelled ? "img" : undefined}
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const IconOverview = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </Icon>
);

export const IconAgents = (p: IconProps) => (
  <Icon {...p}>
    <rect x="5" y="8" width="14" height="11" rx="3" />
    <path d="M12 4v4M9 13h.01M15 13h.01M9.5 16.5h5" />
  </Icon>
);

export const IconApprovals = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 11l2 2 4-4" />
    <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />
  </Icon>
);

export const IconPayments = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h13l-3-3M20 17H7l3 3" />
  </Icon>
);

export const IconTreasury = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 21h18" />
  </Icon>
);

export const IconLedger = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 3h9l4 4v14H6z" />
    <path d="M15 3v4h4M9 12h7M9 16h7" />
  </Icon>
);

export const IconWebhook = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="6" cy="17" r="2.5" />
    <circle cx="18" cy="17" r="2.5" />
    <circle cx="12" cy="6" r="2.5" />
    <path d="M10.7 8.2L7.3 14.8M8.5 17h7M13.3 8.2l3.4 6.6" />
  </Icon>
);

export const IconKey = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="M11 12l9-9M17 6l3 3M14 9l2 2" />
  </Icon>
);

export const IconBilling = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 10h18M7 15h4" />
  </Icon>
);

export const IconSettings = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1" />
  </Icon>
);

export const IconChart = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </Icon>
);

export const IconMenu = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </Icon>
);

export const IconClose = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

export const IconCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);

export const IconAlert = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3l10 18H2z" />
    <path d="M12 10v4M12 17.5h.01" />
  </Icon>
);

export const IconInfo = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 7.5h.01" />
  </Icon>
);

export const IconLock = (p: IconProps) => (
  <Icon {...p}>
    <rect x="5" y="10" width="14" height="10" rx="2" />
    <path d="M8 10V7a4 4 0 018 0v3" />
  </Icon>
);

export const IconFreeze = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 2v20M4.5 6.5l15 11M19.5 6.5l-15 11M9 4l3 2 3-2M9 20l3-2 3 2" />
  </Icon>
);

export const IconCopy = (p: IconProps) => (
  <Icon {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a1 1 0 011-1h10" />
  </Icon>
);

export const IconExternal = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" />
  </Icon>
);

export const IconRefresh = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 11a8 8 0 00-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0014.5 4.5L20 16M20 20v-4h-4" />
  </Icon>
);

export const IconSun = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Icon>
);

export const IconMoon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z" />
  </Icon>
);

export const IconMonitor = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </Icon>
);

export const IconSignOut = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15 4h4a1 1 0 011 1v14a1 1 0 01-1 1h-4M10 16l-4-4 4-4M6 12h10" />
  </Icon>
);

export const IconPasskey = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="9" cy="8" r="4" />
    <path d="M3 20a6 6 0 0110.5-4M17 13a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM17 18v3.5M17 20h1.5" />
  </Icon>
);

export const IconWallet = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7a2 2 0 012-2h11v4" />
    <rect x="3" y="8" width="18" height="12" rx="2" />
    <path d="M16 14h.01" />
  </Icon>
);

export const IconChevronRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 6l6 6-6 6" />
  </Icon>
);

export const IconChevronDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 9l6 6 6-6" />
  </Icon>
);

export const IconDownload = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </Icon>
);

export const IconPlus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const IconClock = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Icon>
);

export const IconSignature = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14.5 4.5l5 5L9 20H4v-5L14.5 4.5z" />
    <path d="M12.5 6.5l5 5" />
  </Icon>
);

export const IconDroplet = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3s-6 6.4-6 11a6 6 0 0 0 12 0c0-4.6-6-11-6-11z" />
  </Icon>
);

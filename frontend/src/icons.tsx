import type { ComponentChildren, JSX } from "preact";

// Minimal Lucide icon subset, distributed under the ISC license.

type IconProps = Omit<JSX.SVGAttributes<SVGSVGElement>, "size"> & {
  size?: number | string;
  strokeWidth?: number | string;
};

function Icon({
  children,
  size = 24,
  strokeWidth = 2,
  ...props
}: IconProps & { children: ComponentChildren }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={props["aria-label"] ? undefined : true}
      {...props}
    >
      {children}
    </svg>
  );
}

export function Check(props: IconProps) {
  return <Icon {...props}><path d="M20 6 9 17l-5-5" /></Icon>;
}

export function ChevronLeft(props: IconProps) {
  return <Icon {...props}><path d="m15 18-6-6 6-6" /></Icon>;
}

export function ChevronRight(props: IconProps) {
  return <Icon {...props}><path d="m9 18 6-6-6-6" /></Icon>;
}

export function ChevronUp(props: IconProps) {
  return <Icon {...props}><path d="m18 15-6-6-6 6" /></Icon>;
}

export function Dices(props: IconProps) {
  return (
    <Icon {...props}>
      <rect width="12" height="12" x="2" y="10" rx="2" ry="2" />
      <path d="m17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6" />
      <path d="M6 18h.01" /><path d="M10 14h.01" />
      <path d="M15 6h.01" /><path d="M18 9h.01" />
    </Icon>
  );
}

export function Download(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </Icon>
  );
}

export function Folder(props: IconProps) {
  return <Icon {...props}><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></Icon>;
}

export function House(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
      <path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </Icon>
  );
}

export function ImageIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </Icon>
  );
}

export function Images(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m22 11-1.296-1.296a2.4 2.4 0 0 0-3.408 0L11 16" />
      <path d="M4 8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2" />
      <circle cx="13" cy="7" r="1" fill="currentColor" />
      <rect x="8" y="2" width="14" height="14" rx="2" />
    </Icon>
  );
}

export function LoaderCircle(props: IconProps) {
  return <Icon {...props}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></Icon>;
}

export function Maximize2(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M15 3h6v6" /><path d="m21 3-7 7" />
      <path d="m3 21 7-7" /><path d="M9 21H3v-6" />
    </Icon>
  );
}

export function Menu(props: IconProps) {
  return <Icon {...props}><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /></Icon>;
}

export function Minimize2(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m14 10 7-7" /><path d="M20 10h-6V4" />
      <path d="m3 21 7-7" /><path d="M4 14h6v6" />
    </Icon>
  );
}

export function RefreshCw(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </Icon>
  );
}

export function Search(props: IconProps) {
  return <Icon {...props}><path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" /></Icon>;
}

export function ScanSearch(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 7V5a2 2 0 0 1 2-2h2" />
      <path d="M17 3h2a2 2 0 0 1 2 2v2" />
      <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
      <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
      <circle cx="10.8" cy="10.8" r="3.8" />
      <path d="m14 14 3.2 3.2" />
    </Icon>
  );
}

export function X(props: IconProps) {
  return <Icon {...props}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Icon>;
}

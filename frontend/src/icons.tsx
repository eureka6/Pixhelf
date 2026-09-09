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

export function MoreHorizontal(props: IconProps) {
  return <Icon {...props}><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></Icon>;
}

export function Info(props: IconProps) {
  return <Icon {...props}><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10h.01" /></Icon>;
}

export function UserRound(props: IconProps) {
  return <Icon {...props}><circle cx="12" cy="8" r="5" /><path d="M20 21a8 8 0 0 0-16 0" /></Icon>;
}

export function ExternalLink(props: IconProps) {
  return <Icon {...props}><path d="M15 3h6v6m0-6L10 14M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4" /></Icon>;
}

export function Copy(props: IconProps) {
  return <Icon {...props}><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></Icon>;
}

export function Check(props: IconProps) {
  return <Icon {...props}><path d="m20 6-11 11-5-5" /></Icon>;
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

export function BookImage(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M7 3v18m3-5 3-4 3 3 2-2" />
      <circle cx="14" cy="8" r="1" />
    </Icon>
  );
}

export function Cloud(props: IconProps) {
  return <Icon {...props}><path d="M20 16.5A4.5 4.5 0 0 0 18 8a6 6 0 0 0-11.5-1A5 5 0 0 0 7 17h3m4 0h7m-3-3 3 3-3 3" /></Icon>;
}

export function Folder(props: IconProps) {
  return <Icon {...props}><path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></Icon>;
}

export function FileIcon(props: IconProps) {
  return <Icon {...props}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8m-8 4h5" /></Icon>;
}

export function Grid(props: IconProps) {
  return <Icon {...props}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></Icon>;
}

export function ListIcon(props: IconProps) {
  return <Icon {...props}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></Icon>;
}

export function LoaderCircle(props: IconProps) {
  return <Icon {...props}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></Icon>;
}

export function Settings(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 2h4l.5 2.5 1.8 1 2.4-.8 2 3.4-1.9 1.7v4.4l1.9 1.7-2 3.4-2.4-.8-1.8 1L14 22h-4l-.5-2.5-1.8-1-2.4.8-2-3.4 1.9-1.7V9.8L3.3 8.1l2-3.4 2.4.8 1.8-1Z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

export function KeyRound(props: IconProps) {
  return <Icon {...props}><circle cx="16.5" cy="7.5" r="5.5" /><path d="m12.6 11.4-9.1 9.1H1.5v-4l3-3h3v-3l1.1-1.1" /></Icon>;
}

export function LogOut(props: IconProps) {
  return <Icon {...props}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></Icon>;
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

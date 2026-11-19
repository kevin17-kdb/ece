import type { SVGProps } from "react";

export type IconName =
  | "activity"
  | "arrow-left"
  | "book"
  | "check"
  | "chevron-right"
  | "circuit"
  | "code"
  | "copy"
  | "cpu"
  | "file"
  | "flask"
  | "folder"
  | "grid"
  | "layers"
  | "plus"
  | "play"
  | "redo"
  | "refresh"
  | "save"
  | "search"
  | "settings"
  | "target"
  | "trash"
  | "undo"
  | "x";

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: number;
}

const paths: Record<IconName, string> = {
  activity: "M3 12h4l2-7 4 14 2-7h6",
  "arrow-left": "M19 12H5m7 7-7-7 7-7",
  book: "M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5zm0 0V21",
  check: "m5 12 4 4L19 6",
  "chevron-right": "m9 18 6-6-6-6",
  circuit: "M6 3v4m0 10v4M18 3v4m0 10v4M3 6h4m10 0h4M3 18h4m10 0h4M10 8h4v8h-4z",
  code: "m8 9-3 3 3 3m8-6 3 3-3 3m-3-8-2 10",
  cpu: "M8 8h8v8H8zM4 10h4m-4 4h4m8-4h4m-4 4h4M10 4v4m4-4v4m-4 8v4m4-4v4",
  file: "M6 3h8l4 4v14H6zM14 3v5h5",
  flask: "M9 3h6m-5 0v6l-5 9a2 2 0 0 0 1.7 3h8.6a2 2 0 0 0 1.7-3l-5-9V3m-6.5 13h11",
  folder: "M3 6h7l2 2h9v11H3z",
  grid: "M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z",
  layers: "m12 3 9 5-9 5-9-5zm-9 9 9 5 9-5m-18 5 9 5 9-5",
  plus: "M12 5v14M5 12h14",
  play: "m9 6 9 6-9 6z",
  save: "M5 3h12l2 2v16H5zm3 0v6h8V3M8 21v-7h8v7",
  search: "m20 20-4.5-4.5m2-5.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z",
  settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4",
  target: "M12 3v3m0 12v3M3 12h3m12 0h3M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z",
  trash: "M4 7h16M10 11v6m4-6v6M6 7l1 14h10l1-14M9 7V4h6v3",
  undo: "M9 14 4 9l5-5M4 9h10a5 5 0 0 1 0 10h-3",
  redo: "m15 14 5-5-5-5M20 9H10a5 5 0 0 0 0 10h3",
  refresh: "M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5",
  copy: "M8 8h11v11H8zM5 16V5h11",
  x: "m6 6 12 12M18 6 6 18",
};

export function Icon({ name, size = 18, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      focusable="false"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      <path d={paths[name]} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
    </svg>
  );
}

/** One consistent SVG icon set (replaces platform-dependent emoji and glyphs). */
const PATHS = {
  play: 'M8 5.5v13l11-6.5-11-6.5z',
  pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
  back15: 'M11.5 5.5V2L7 6.5 11.5 11V7.5a6 6 0 1 1-6 6H3.5a8 8 0 1 0 8-8z',
  forward15: 'M12.5 5.5V2L17 6.5 12.5 11V7.5a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zm-6 9a6 6 0 0 0 12 0h-2a4 4 0 0 1-8 0H6zm5 7.9V22h2v-2.1A8 8 0 0 0 12 20a8 8 0 0 0-1-.1z',
  stop: 'M7 7h10v10H7z',
  car: 'M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11a2 2 0 0 1 2 2v4h-2v2h-2.5v-2h-9v2H5v-2H3v-4a2 2 0 0 1 2-2zm2.1 0h9.8l-1-3.3H8.1L7.1 11zM6.5 15a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5zm11 0a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5z',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5zm0 4.5l-1.3 2.7-3 .4 2.2 2.1-.5 2.9 2.6-1.4 2.6 1.4-.5-2.9 2.2-2.1-3-.4L12 8z',
  starFilled: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5z',
  download: 'M11 4h2v8.2l3.3-3.3 1.4 1.4L12 16l-5.7-5.7 1.4-1.4 3.3 3.3V4zM5 18h14v2H5z',
  downloaded: 'M9.5 16.2L5.3 12l1.4-1.4 2.8 2.8 7.8-7.8 1.4 1.4-9.2 9.2zM5 18h14v2H5z',
  check: 'M9.5 16.2L5.3 12l1.4-1.4 2.8 2.8 7.8-7.8 1.4 1.4-9.2 9.2z',
  close: 'M6.4 5L12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5z',
  chevronUp: 'M7.4 15.4L12 10.8l4.6 4.6L18 14l-6-6-6 6 1.4 1.4z',
  chevronDown: 'M7.4 8.6L12 13.2l4.6-4.6L18 10l-6 6-6-6 1.4-1.4z',
  arrowUp: 'M11 20V7.8l-5.6 5.6L4 12l8-8 8 8-1.4 1.4L13 7.8V20h-2z',
  arrowDown: 'M13 4v12.2l5.6-5.6L20 12l-8 8-8-8 1.4-1.4 5.6 5.6V4h2z',
  trash: 'M9 3h6l1 2h4v2H4V5h4l1-2zm-3 5h12l-1 13H7L6 8zm4 2v9h1.5v-9H10zm2.5 0v9H14v-9h-1.5z',
  search: 'M10.5 4a6.5 6.5 0 0 1 5.2 10.4l4.4 4.4-1.4 1.4-4.4-4.4A6.5 6.5 0 1 1 10.5 4zm0 2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z',
  sparkle: 'M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2zm6.5 12l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6z',
  bolt: 'M13 2L4.5 13.5H11L10 22l8.5-11.5H12L13 2z',
  layers: 'M12 3l9.5 5L12 13 2.5 8 12 3zm-7.4 9.2L12 16l7.4-3.8 2.1 1.1L12 18.2 2.5 13.3l2.1-1.1zm0 4.5L12 20.5l7.4-3.8 2.1 1.1L12 22.7l-9.5-4.9 2.1-1.1z',
  library: 'M4 4h3v16H4V4zm5 0h3v16H9V4zm5.2.6l2.9-.8 4.2 15.5-2.9.8L14.2 4.6z',
  user: 'M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm0 10c4.4 0 8 2 8 4.5V21H4v-2.5C4 16 7.6 14 12 14z',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z',
  refresh: 'M17.7 6.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.8-4.2L13 11h7V4l-2.3 2.3z',
  alert: 'M12 3l10 18H2L12 3zm-1 6v6h2V9h-2zm0 8v2h2v-2h-2z',
  edit: 'M4 17.2V20h2.8l8.3-8.3-2.8-2.8L4 17.2zM19.7 7a1 1 0 0 0 0-1.4l-1.3-1.3a1 1 0 0 0-1.4 0l-1.6 1.6 2.8 2.8L19.7 7z',
  expand: 'M7.4 15.4L12 10.8l4.6 4.6L18 14l-6-6-6 6 1.4 1.4z',
  bell: 'M12 22a2.5 2.5 0 0 0 2.5-2.5h-5A2.5 2.5 0 0 0 12 22zm7-5.5V11a7 7 0 0 0-5.5-6.8V3h-3v1.2A7 7 0 0 0 5 11v5.5L3 18.5v.5h18v-.5l-2-2z',
  text: 'M4 5h16v2H4V5zm0 4h16v2H4V9zm0 4h10v2H4v-2zm0 4h13v2H4v-2z',
  restart: 'M12 5V2L7.5 6.5 12 11V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z',
  moon: 'M14.5 2.5a9.5 9.5 0 1 0 7 15.9A8 8 0 0 1 14.5 2.5z',
} as const;

export type IconName = keyof typeof PATHS;

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  /** Provide only when the icon conveys meaning without adjacent text. */
  title?: string;
}

export function Icon({ name, size = 20, className, title }: IconProps) {
  return (
    <svg
      className={`icon ${className ?? ''}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title && <title>{title}</title>}
      <path d={PATHS[name]} />
    </svg>
  );
}

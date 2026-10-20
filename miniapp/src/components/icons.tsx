// Иконки — линейные SVG, цвет берут из currentColor.
import type { ReactNode } from "react";

function Icon({ size = 20, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

type P = { size?: number };

export const HomeIcon = (p: P) => <Icon {...p}><path d="M3 10.5 12 3l9 7.5V21H3z" /><path d="M9.5 21v-6h5v6" /></Icon>;
export const TrendIcon = (p: P) => <Icon {...p}><polyline points="3 17 9 11 13 15 21 7" /><polyline points="15 7 21 7 21 13" /></Icon>;
export const BookIcon = (p: P) => (
  <Icon {...p}><path d="M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4z" /><line x1="8" y1="9" x2="16" y2="9" /><line x1="8" y1="13" x2="14" y2="13" /></Icon>
);
export const PauseIcon = (p: P) => <Icon {...p}><line x1="9" y1="5" x2="9" y2="19" /><line x1="15" y1="5" x2="15" y2="19" /></Icon>;
export const PlayIcon = (p: P) => <Icon {...p}><polygon points="7 4 20 12 7 20 7 4" /></Icon>;
export const BackIcon = (p: P) => <Icon {...p}><polyline points="15 18 9 12 15 6" /></Icon>;
export const ChevronIcon = (p: P) => <Icon {...p}><polyline points="9 18 15 12 9 6" /></Icon>;
export const CloseIcon = (p: P) => <Icon {...p}><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></Icon>;
export const AlertIcon = (p: P) => (
  <Icon {...p}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></Icon>
);

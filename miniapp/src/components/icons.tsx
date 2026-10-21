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
export const GearIcon = (p: P) => (
  <Icon {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></Icon>
);
export const CheckIcon = (p: P) => <Icon {...p}><polyline points="20 6 9 17 4 12" /></Icon>;
export const WalletIcon = (p: P) => (
  <Icon {...p}><path d="M20 7H5a2 2 0 0 1 0-4h13v4" /><path d="M3 5v14a2 2 0 0 0 2 2h15V7" /><circle cx="16" cy="14" r="1.5" /></Icon>
);
export const ShieldIcon = (p: P) => <Icon {...p}><path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z" /><polyline points="9 12 11 14 15 10" /></Icon>;
export const CandleIcon = (p: P) => <Icon {...p}><line x1="7" y1="3" x2="7" y2="21" /><rect x="5" y="7" width="4" height="8" rx="1" /><line x1="17" y1="3" x2="17" y2="21" /><rect x="15" y="10" width="4" height="6" rx="1" /></Icon>;

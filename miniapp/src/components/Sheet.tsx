import type { ReactNode } from "react";
import { CloseIcon } from "./icons";

/** Панель снизу поверх экрана, как у бирж: ордер, выбор пары, выбор счёта. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <strong>{title}</strong>
          <button className="icon-btn btn btn-ghost" aria-label="Закрыть" onClick={onClose}><CloseIcon /></button>
        </header>
        {children}
      </div>
    </div>
  );
}

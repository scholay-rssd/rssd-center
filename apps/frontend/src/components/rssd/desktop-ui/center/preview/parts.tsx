// Small pieces shared by the Center tabs and drawers.
import { useEffect, useRef, type ReactNode } from "react";
import { tr } from "../../uiText";

export const shortDate = (date: string) => date.slice(5).replace("-", "/");
export const Icon = ({
  kind,
}: {
  kind: "arrow" | "plus" | "close" | "send" | "search" | "calendar";
}) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {kind === "arrow" ? (
      <path d="m9 5 7 7-7 7" />
    ) : kind === "plus" ? (
      <path d="M12 5v14M5 12h14" />
    ) : kind === "close" ? (
      <path d="m6 6 12 12M6 18 18 6" />
    ) : kind === "send" ? (
      <path d="m12 20 0-16m-6 6 6-6 6 6" />
    ) : kind === "search" ? (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4 4" />
      </>
    ) : (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M7 3v4m10-4v4M3 11h18" />
      </>
    )}
  </svg>
);

export function Drawer({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const focused = document.activeElement as HTMLElement | null;
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      dialog.close?.();
      focused?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="center-preview-drawer"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div>
        <header>
          <span>{title}</span>
          <button onClick={onClose} aria-label={tr("关闭详情")}>
            <Icon kind="close" />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

export function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="cp-empty">
      <Icon kind="calendar" />
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

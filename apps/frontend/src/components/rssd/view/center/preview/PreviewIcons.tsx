import AppIcon from "../../components/Icon";
import type { PreviewTab } from "./model";
import { platformImage, siteImage } from "./assets";

export function WorkspaceIcon({
  workspaceId,
  size = 28,
}: {
  workspaceId: string;
  size?: number;
}) {
  const src = siteImage(workspaceId);
  return (
    <span
      className="cp-brand cp-workspace-brand"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {src ? (
        <img src={src} alt="" draggable={false} />
      ) : (
        <AppIcon name="globe" size={size - 8} />
      )}
    </span>
  );
}

export function DestinationIcon({
  name,
  workspaceId,
  size = 30,
}: {
  name: string;
  workspaceId?: string;
  size?: number;
}) {
  const src = platformImage(name);
  if (!src && workspaceId)
    return <WorkspaceIcon workspaceId={workspaceId} size={size} />;
  return (
    <span
      className="cp-brand cp-platform-brand"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {src ? (
        <img src={src} alt="" draggable={false} />
      ) : (
        <AppIcon name="globe" size={size - 8} />
      )}
    </span>
  );
}

export function NavigationIcon({ tab }: { tab: PreviewTab }) {
  if (tab === "calendar")
    return (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="5" width="18" height="16" rx="2.5" />
        <path d="M7 3v4m10-4v4M3 11h18M7 15h2m6 0h2M7 18h2" />
      </svg>
    );
  return (
    <AppIcon
      name={
        {
          overview: "grid",
          demands: "inbox",
          channels: "send",
          assistant: "sparkle",
          legacy: "folder",
          works: "file",
          settings: "settings",
        }[tab] as "grid" | "inbox" | "send" | "sparkle" | "folder" | "file" | "settings"
      }
      size={18}
    />
  );
}

/** The RSSD mark, as the desktop client draws it: orthogonal letterforms in the text colour. */
export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      className="cp-brand-mark"
      width={size}
      height={size}
      viewBox="8 12 112 104"
      fill="none"
      stroke="currentColor"
      strokeWidth="7"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
    >
      <path d="M16.5 108V20H30.5V108M16.5 64H30.5 M57.5 20H43.5V64H57.5V108H43.5 M84.5 20H70.5V64H84.5V108H70.5 M97.5 20H111.5V108H97.5Z" />
    </svg>
  );
}

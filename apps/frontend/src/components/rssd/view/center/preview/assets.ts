// Brand images served by the Center from /rssd-ui.
const sites: Record<string, string> = {
  "academic": "/rssd-ui/sites/academic.png",
  "enter": "/rssd-ui/sites/enter-bw-v8.webp",
  "legis": "/rssd-ui/sites/legis-bw-v8.webp",
  "lingxi": "/rssd-ui/sites/lingxi-bw-v8.webp",
  "metho": "/rssd-ui/sites/metho-bw-v8.webp",
  "personal": "/rssd-ui/sites/personal-bw-v8.webp",
  "pets": "/rssd-ui/sites/pets-bw-v8.webp",
  "piggytuck": "/rssd-ui/sites/piggytuck-bw-v8.webp",
  "study": "/rssd-ui/sites/study-bw-v8.webp",
  "xsiching": "/rssd-ui/sites/xsiching-bw-v8.webp"
};
const platforms: Record<string, string> = {
  "Discourse": "/rssd-ui/platforms/discourse.svg",
  "Facebook": "/rssd-ui/platforms/facebook.svg",
  "LinkedIn": "/rssd-ui/platforms/linkedin.svg",
  "Telegram": "/rssd-ui/platforms/telegram.svg",
  "X": "/rssd-ui/platforms/x.svg"
};
export const siteImage = (workspaceId: string): string | undefined => sites[workspaceId];
export const platformImage = (name: string): string | undefined => platforms[name];

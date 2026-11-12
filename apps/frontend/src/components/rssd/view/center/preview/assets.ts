// Brand images served by the Center from /rssd-ui.
const sites: Record<string, string> = {
  "academic": "/rssd-ui/sites/academic.png",
  "enter": "/rssd-ui/sites/enter-bw-v8.webp",
  "legis": "/rssd-ui/sites/legis-bw-v8.webp",
  "xsime": "/rssd-ui/sites/xsime-bw-v8.webp",
  "metho": "/rssd-ui/sites/metho-bw-v8.webp",
  "personal": "/rssd-ui/sites/personal-bw-v8.webp",
  "pets": "/rssd-ui/sites/pets-bw-v8.webp",
  "piggytuck": "/rssd-ui/sites/piggytuck-bw-v8.webp",
  "study": "/rssd-ui/sites/study-bw-v8.webp",
  "xsiching": "/rssd-ui/sites/xsiching-bw-v8.webp"
};
// Our own mark for the one destination kind that is not a connected account.
const own: Record<string, string> = { discourse: "/rssd-ui/platforms/discourse.svg" };
// A connected account is named by the application's platform identifier, and
// the application ships one icon for each under /icons/platforms.
const accounts = new Set([
  "bluesky", "devto", "discord", "dribbble", "facebook", "gmb", "hashnode", "instagram-standalone", "instagram",
  "kick", "lemmy", "linkedin-page", "linkedin", "listmonk", "mastodon-custom", "mastodon", "medium", "mewe",
  "moltbook", "nostr", "pinterest", "reddit", "skool", "slack", "telegram", "threads", "tiktok-business", "tiktok",
  "tumblr", "twitch", "vk", "whop", "wordpress", "wrapcast", "x", "youtube",
]);
export const siteImage = (workspaceId: string): string | undefined => sites[workspaceId];
/** `name` is a platform identifier as the Center reports it, in any letter case. */
export const platformImage = (name: string): string | undefined => {
  const id = name.toLowerCase();
  return own[id] || (accounts.has(id) ? "/icons/platforms/" + id + ".png" : undefined);
};

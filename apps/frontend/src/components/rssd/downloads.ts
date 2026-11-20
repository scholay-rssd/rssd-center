// The home page's downloads. Every file is a GitHub release asset of the public
// repositories, fetched by the visitor's browser straight from GitHub, so the
// Center never serves a download. Vaults still update themselves only from the
// Center's signed plugin releases.
export const GITHUB = 'https://github.com/scholay-rssd';
export type Asset = { name: string; browser_download_url: string; size: number };
export type Release = { tag_name: string; html_url: string; prerelease: boolean; draft: boolean; published_at: string; assets: Asset[] };
export type Item = { label: string; pattern: RegExp; minor?: boolean };
export type Group = { id: string; repo: string; title: string; summary: string; guide: { label: string; url: string }; items: Item[] };
export type Link = { label: string; url: string; size: number; minor: boolean; development: boolean };
export type Picked = { version: string; date: string; prerelease: boolean; page: string; links: Link[] };

const checksums: Item = { label: 'SHA256SUMS.txt', pattern: /^SHA256SUMS\.txt$/, minor: true };
export const GROUPS: Group[] = [
  {
    id: 'obsidian', repo: 'rssd-obsidian', title: 'Obsidian 插件',
    summary: '入门 vault 已经装好 RSSD 插件。解压后用 Obsidian 打开里面的 RSSD 文件夹，信任插件，再填入管理员给你的密钥。以后的新版本会从中心自动更新。',
    guide: { label: '插件说明', url: GITHUB + '/rssd-obsidian#readme' },
    items: [
      { label: '入门 vault', pattern: /^rssd-starter-vault-.+\.zip$/ },
      { label: 'main.js', pattern: /^main\.js$/, minor: true },
      { label: 'manifest.json', pattern: /^manifest\.json$/, minor: true },
    ],
  },
  {
    id: 'desktop', repo: 'rssd', title: '桌面应用',
    summary: '在 Windows 和 macOS 上订阅 RSS、阅读原文、选取素材并完成写作，需要时再连接中心领取任务。',
    guide: { label: '开始使用', url: GITHUB + '/rssd#开始使用' },
    items: [
      { label: 'macOS（Apple 芯片）', pattern: /^rssd-[\d.]+(-[\w.]+)?-macos-arm64(-development)?\.zip$/ },
      { label: 'macOS（Intel）', pattern: /^rssd-[\d.]+(-[\w.]+)?-macos-x64(-development)?\.zip$/ },
      { label: 'Windows', pattern: /^rssd-[\d.]+(-[\w.]+)?-windows-x64-setup\.exe$/ },
      checksums,
    ],
  },
  {
    id: 'cli', repo: 'rssd', title: '命令行（无头）',
    summary: '不需要桌面和浏览器，在服务器或另一台电脑上连接中心，执行写作、翻译和更新任务。',
    guide: { label: '安装说明', url: GITHUB + '/rssd/blob/main/HEADLESS.md' },
    items: [
      { label: 'macOS（Apple 芯片）', pattern: /^rssd-headless-.+-darwin-arm64\.tar\.gz$/ },
      { label: 'macOS（Intel）', pattern: /^rssd-headless-.+-darwin-x64\.tar\.gz$/ },
      { label: 'Linux x64', pattern: /^rssd-headless-.+-linux-x64\.tar\.gz$/ },
      checksums,
    ],
  },
];

export const releasesApi = (repo: string) => 'https://api.github.com/repos/scholay-rssd/' + repo + '/releases?per_page=10';
export const releasesPage = (repo: string) => GITHUB + '/' + repo + '/releases';

/** The newest published release (GitHub lists newest first) that has one of the group's main files. */
export function pick(releases: Release[] | undefined, group: Group): Picked | null {
  for (const release of Array.isArray(releases) ? releases : []) {
    if (release.draft) continue;
    const links = group.items.flatMap(item => {
      const asset = (release.assets || []).find(a => item.pattern.test(a.name));
      return asset ? [{ label: item.label, url: asset.browser_download_url, size: asset.size, minor: !!item.minor, development: /-development\./.test(asset.name) }] : [];
    });
    if (!links.some(link => !link.minor)) continue;
    return { version: release.tag_name.replace(/^v/, ''), date: release.published_at.slice(0, 10), prerelease: release.prerelease, page: release.html_url, links };
  }
  return null;
}

export const size = (bytes: number) => bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(0) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';

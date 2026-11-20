'use client';
// The Center's public home page: what RSSD is, where to download it, and the
// sign-in for the owner and existing accounts. Registration is closed.
import useSWR from 'swr';
import { useShellMode, Mode } from './mode';
import { GITHUB, GROUPS, Group, Release, pick, releasesApi, releasesPage, size } from './downloads';
import './view/fonts.css';
import './view/tokens.css';
import './home.css';

const loadReleases = async (url: string): Promise<Release[]> => {
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw Error('GitHub ' + response.status);
  return response.json();
};
const options = { revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false };
const usePluginReleases = () => useSWR(releasesApi('rssd-obsidian'), loadReleases, options);
const useAppReleases = () => useSWR(releasesApi('rssd'), loadReleases, options);

function Downloads({ group, releases, failed }: { group: Group; releases?: Release[]; failed: boolean }) {
  const picked = pick(releases, group);
  const main = picked?.links.filter(link => !link.minor) || [], minor = picked?.links.filter(link => link.minor) || [];
  return (
    <article className="rh-card" aria-labelledby={'rh-' + group.id}>
      <header>
        <h3 id={'rh-' + group.id}>{group.title}</h3>
        {picked && <p className="rh-version">{picked.version}{picked.prerelease && <span className="rh-badge">预发布</span>} · {picked.date}</p>}
      </header>
      <p>{group.summary}</p>
      {picked ? (
        <>
          <ul className="rh-links">
            {main.map(link => <li key={link.url}><a className="rh-download" href={link.url}>{link.label}<span>{size(link.size)}</span></a></li>)}
          </ul>
          {main.some(link => link.development) && <p className="rh-note">macOS 版是未签名的开发版，第一次打开会被系统拦下：到“系统设置 → 隐私与安全性”里点“仍要打开”。</p>}
          <p className="rh-minor">
            {minor.map(link => <a key={link.url} href={link.url}>{link.label}</a>)}
            <a href={picked.page}>版本说明</a>
            <a href={group.guide.url}>{group.guide.label}</a>
          </p>
        </>
      ) : (
        <p className="rh-minor">
          <span>{failed || releases ? '暂时读不到最新版本。' : '正在读取最新版本…'}</span>
          <a href={releasesPage(group.repo)}>前往 GitHub Releases</a>
          <a href={group.guide.url}>{group.guide.label}</a>
        </p>
      )}
    </article>
  );
}

export function RssdHome({ initialMode }: { initialMode?: Mode }) {
  const [mode, toggle] = useShellMode(initialMode);
  const plugin = usePluginReleases(), app = useAppReleases();
  const data = (group: Group) => group.repo === 'rssd-obsidian' ? plugin : app;
  return (
    <div className="rssd-desktop rssd-home" data-mode={mode}>
      <header className="rh-top">
        <a className="rh-brand" href="/"><img src="/rssd-ui/rssd-icon.svg" alt="" width={28} height={28} />RSSD 中心</a>
        <nav>
          <a href="#downloads">下载</a>
          <a href={GITHUB}>GitHub</a>
          <button type="button" onClick={toggle} aria-label={mode === 'dark' ? '切换到浅色' : '切换到深色'}>{mode === 'dark' ? '浅色' : '深色'}</button>
          <a className="rh-signin" href="/auth/login">登录</a>
        </nav>
      </header>
      <main>
        <section className="rh-hero">
          <h1>从阅读到写作，再到自己的站点</h1>
          <p>RSSD 从 RSS、网页和自己的资料出发，完成研究、写作和翻译，再把作品发布到自己的内容站点。它把个人写作设备、内容中心和独立站点接在一起。</p>
          <p className="rh-actions"><a className="rh-primary" href="#downloads">下载</a><a href={GITHUB + '/rssd#readme'}>了解 RSSD</a></p>
        </section>
        <section className="rh-parts" aria-label="RSSD 由三部分组成">
          <div><h2>写作设备</h2><p>Obsidian 插件、桌面应用或命令行。在本地阅读、取材和写作，作品和草稿都留在自己的设备上。</p></div>
          <div><h2>内容中心</h2><p>就是这里。集中管理选题需求、写作要求、作品的语言版本和修订，派发给已连接的设备，并记录每次发布。</p></div>
          <div><h2>独立站点</h2><p>每个领域一个站点，有自己的栏目、写法和主题。作品发布后生成文章页、笔记页和卡片。</p></div>
        </section>
        <section id="downloads" className="rh-downloads" aria-labelledby="rh-downloads-title">
          <h2 id="rh-downloads-title">下载</h2>
          <p className="rh-lead">所有安装包都来自 RSSD 的开源仓库在 GitHub 上的发布页。</p>
          <div className="rh-grid">
            {GROUPS.map(group => <Downloads key={group.id} group={group} releases={data(group).data} failed={!!data(group).error} />)}
          </div>
        </section>
        <section className="rh-account" aria-labelledby="rh-account-title">
          <h2 id="rh-account-title">账号与密钥</h2>
          <p>这个中心不开放注册。写作设备用管理员发放的密钥连接；只有管理员和已有账号需要登录。</p>
          <p className="rh-actions"><a className="rh-primary" href="/auth/login">管理员 / 已有账号登录</a></p>
        </section>
      </main>
      <footer className="rh-footer"><a href={GITHUB}>github.com/scholay-rssd</a></footer>
    </div>
  );
}

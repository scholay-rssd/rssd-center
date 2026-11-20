import { Metadata } from 'next';
import { cookies } from 'next/headers';
import { RssdHome } from '@gitroom/frontend/components/rssd/home';
export const metadata: Metadata = {
  title: 'RSSD 中心',
  description: 'RSSD 从 RSS、网页和自己的资料出发，完成研究、写作和翻译，再发布到自己的内容站点。下载 Obsidian 插件、桌面应用和命令行。',
};
// Signed-out visitors only: the proxy sends a signed-in account on to /rssd.
export default async function HomePage() {
  const mode = (await cookies()).get('mode')?.value === 'light' ? 'light' : 'dark';
  return <RssdHome initialMode={mode} />;
}

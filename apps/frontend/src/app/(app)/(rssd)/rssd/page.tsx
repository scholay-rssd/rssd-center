import { Metadata } from 'next';
import { cookies } from 'next/headers';
import { RssdCenter } from '@gitroom/frontend/components/rssd/live-center';
export const metadata: Metadata = { title: 'RSSD 中心' };
export default async function RssdPage({searchParams}: {searchParams: Promise<Record<string,string|string[]|undefined>>}) {
  const query = await searchParams, text = (value: unknown) => typeof value === 'string' ? value : undefined;
  const mode = (await cookies()).get('mode')?.value === 'light' ? 'light' : 'dark';
  return <RssdCenter key={JSON.stringify([query.tab,query.view,query.workspaceId])} initialTab={text(query.tab)} initialView={text(query.view)} initialWorkspace={text(query.workspaceId)} initialMode={mode} accountsAdded={Boolean(text(query.added))}/>;
}

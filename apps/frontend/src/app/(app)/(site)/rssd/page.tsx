import { Metadata } from 'next';
import { RssdWorkspace } from '@gitroom/frontend/components/rssd/workspace';
export const metadata: Metadata = { title: 'RSSD 中心' };
export default async function RssdPage({searchParams}: {searchParams: Promise<Record<string,string|string[]|undefined>>}) {
  const query = await searchParams;
  return <RssdWorkspace initialTab={typeof query.tab === 'string' ? query.tab : undefined} initialWorkspace={typeof query.workspaceId === 'string' ? query.workspaceId : undefined}/>;
}

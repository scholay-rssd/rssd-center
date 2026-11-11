import { ReactNode } from 'react';
import { RssdShell } from '@gitroom/frontend/components/rssd/shell';

export default async function Layout({ children }: { children: ReactNode }) {
  return <RssdShell>{children}</RssdShell>;
}

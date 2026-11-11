'use client';
// The shell of the /rssd pages: the signed-in account, and nothing else around
// the work centre. The publishing tools keep the application's own layout.
import { ReactNode, useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { ContextWrapper } from '@gitroom/frontend/components/layout/user.context';

export function RssdShell({ children }: { children: ReactNode }) {
  const fetch = useFetch();
  const load = useCallback(async (path: string) => (await fetch(path)).json(), [fetch]);
  const { data: user } = useSWR('/user/self', load, { revalidateOnFocus: false, revalidateOnReconnect: false, revalidateIfStale: false, refreshWhenOffline: false, refreshWhenHidden: false });
  if (!user) return null;
  return <ContextWrapper user={user}>{children}</ContextWrapper>;
}

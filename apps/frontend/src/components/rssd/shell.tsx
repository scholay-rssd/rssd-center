'use client';
// The shell of every /rssd page: the signed-in account around the work centre,
// with no application sidebar. The application's own pages are not part of the
// interface; only its account-connection step is reused (see channels-admin).
import { ReactNode, useCallback, useEffect } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { ContextWrapper } from '@gitroom/frontend/components/layout/user.context';
import { MantineWrapper } from '@gitroom/react/helpers/mantine.wrapper';
import { ContinueProvider } from '@gitroom/frontend/components/layout/continue.provider';

export function RssdShell({ children }: { children: ReactNode }) {
  const fetch = useFetch();
  const load = useCallback(async (path: string) => (await fetch(path)).json(), [fetch]);
  const { data: user } = useSWR('/user/self', load, { revalidateOnFocus: false, revalidateOnReconnect: false, revalidateIfStale: false, refreshWhenOffline: false, refreshWhenHidden: false });
  // The application's layout names its own tab icon; on these pages the tab carries the RSSD one.
  useEffect(() => { document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]').forEach(link => { link.type = 'image/svg+xml'; link.href = '/rssd-ui/rssd-icon.svg'; }); }, []);
  if (!user) return null;
  // Some platforms ask which page or account to use after sign-in; that step is the application's own dialog.
  return <ContextWrapper user={user}><MantineWrapper><ContinueProvider />{children}</MantineWrapper></ContextWrapper>;
}

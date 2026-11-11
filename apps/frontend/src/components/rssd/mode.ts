'use client';
import { useEffect, useState } from 'react';

export type Mode = 'light' | 'dark';
/** Light/dark is the `mode` cookie and a class on <body>. Without `initial` the cookie is read on mount. */
export function useShellMode(initial?: Mode): [Mode, () => void] {
  const [mode, setMode] = useState<Mode>(initial || 'dark');
  useEffect(() => {
    const body = document.body, wanted = initial || (/(?:^|; )mode=light(?:;|$)/.test(document.cookie) ? 'light' : 'dark');
    if (!body.classList.contains(wanted)) { body.classList.remove('dark', 'light'); body.classList.add(wanted); }
    const read = () => setMode(body.classList.contains('light') ? 'light' : 'dark');
    read();
    const observer = new MutationObserver(read);
    observer.observe(body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [initial]);
  const toggle = () => {
    const next = mode === 'dark' ? 'light' : 'dark';
    document.cookie = 'mode=' + next + '; path=/; max-age=31536000; SameSite=Lax';
    document.body.classList.remove('dark', 'light'); document.body.classList.add(next);
  };
  return [mode, toggle];
}

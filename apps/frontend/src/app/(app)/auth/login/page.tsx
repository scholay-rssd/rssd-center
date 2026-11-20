export const dynamic = 'force-dynamic';
import { Login } from '@gitroom/frontend/components/auth/login';
import { Metadata } from 'next';
import { internalFetch } from '@gitroom/helpers/utils/internal.fetch';
export const metadata: Metadata = {
  title: 'RSSD 中心 · 登录',
  description: '',
};
export default async function Auth() {
  // With registration closed the page offers no way to sign up.
  let canRegister = process.env.DISABLE_REGISTRATION !== 'true';
  if (!canRegister) {
    try {
      canRegister = !!(await (await internalFetch('/auth/can-register')).json()).register;
    } catch {}
  }
  return <Login canRegister={canRegister} />;
}

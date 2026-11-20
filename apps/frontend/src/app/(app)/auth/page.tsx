import { internalFetch } from '@gitroom/helpers/utils/internal.fetch';
export const dynamic = 'force-dynamic';
import { Register } from '@gitroom/frontend/components/auth/register';
import { Metadata } from 'next';
import { redirect } from 'next/navigation';
export const metadata: Metadata = {
  title: 'RSSD 中心 · 登录',
  description: '',
};
// Signed-out visitors are sent here. With registration closed this Center only
// signs existing accounts in, so they go straight to the sign-in page. A
// `provider` query is a sign-in provider returning here and is still finished
// by the Register component.
export default async function Auth(params: {searchParams: Promise<{provider: string}>}) {
  if (process.env.DISABLE_REGISTRATION === 'true') {
    const canRegister = (
      await (await internalFetch('/auth/can-register')).json()
    ).register;
    if (!canRegister && !(await params?.searchParams)?.provider) {
      redirect('/auth/login');
    }
  }
  return <Register />;
}

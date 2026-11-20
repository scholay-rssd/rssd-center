export const dynamic = 'force-dynamic';
import { Forgot } from '@gitroom/frontend/components/auth/forgot';
import { Metadata } from 'next';
export const metadata: Metadata = {
  title: 'RSSD 中心 · 找回密码',
  description: '',
};
export default async function Auth() {
  return <Forgot />;
}

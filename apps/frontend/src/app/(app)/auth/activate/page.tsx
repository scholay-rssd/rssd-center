export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { Activate } from '@gitroom/frontend/components/auth/activate';
export const metadata: Metadata = {
  title: 'RSSD 中心 · 激活账号',
  description: '',
};
export default async function Auth() {
  return <Activate />;
}

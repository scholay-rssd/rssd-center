import { Metadata } from 'next';
import { DeviceAuthorization } from '@gitroom/frontend/components/rssd/device-authorization';
export const metadata: Metadata = { title: '授权设备 · RSSD', robots: { index: false, follow: false } };
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const query=await searchParams;
  return <DeviceAuthorization requestId={typeof query.request==='string'?query.request:''} userCode={typeof query.code==='string'?query.code:''}/>;
}

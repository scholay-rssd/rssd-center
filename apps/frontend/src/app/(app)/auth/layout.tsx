export const dynamic = 'force-dynamic';
import { ReactNode } from 'react';
import loadDynamic from 'next/dynamic';
import { RssdWordmark } from '@gitroom/frontend/components/rssd/wordmark';
import { MantineWrapper } from '@gitroom/react/helpers/mantine.wrapper';
import { Toaster } from '@gitroom/react/toaster/toaster';
const ReturnUrlComponent = loadDynamic(() => import('./return.url.component'));
export default async function AuthLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <MantineWrapper>
      <Toaster />
      <div className="bg-[#0E0E0E] flex flex-1 p-[12px] gap-[12px] min-h-screen w-screen text-white">
        {/*<style>{`html, body {overflow-x: hidden;}`}</style>*/}
        <ReturnUrlComponent />
        <div className="flex flex-col py-[40px] px-[20px] flex-1 lg:w-[600px] lg:flex-none rounded-[12px] text-white p-[12px] bg-[#1A1919]">
          <div className="w-full max-w-[440px] mx-auto justify-center gap-[20px] h-full flex flex-col text-white">
            <RssdWordmark />
            <div className="flex">{children}</div>
          </div>
        </div>
        <div className="flex-1 hidden lg:flex flex-col justify-center px-[64px] max-w-[640px]">
          <div className="text-[32px] leading-[1.3]">
            从阅读到写作，再到自己的站点
          </div>
          <p className="mt-[16px] text-[16px] text-[#A8A39A] leading-[1.7]">
            这里只供管理员和已有账号登录，不开放注册。写作设备用管理员发放的密钥连接中心，不需要账号。
          </p>
          <p className="mt-[24px] text-[15px] flex gap-[20px]">
            <a className="underline" href="/">返回首页</a>
            <a className="underline" href="/#downloads">下载插件与应用</a>
          </p>
        </div>
      </div>
    </MantineWrapper>
  );
}

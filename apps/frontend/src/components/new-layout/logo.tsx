'use client';
import Link from 'next/link';
export const Logo = () => <Link href="/rssd" aria-label="RSSD 中心" className="mt-[8px] min-w-[60px] min-h-[60px] flex flex-col items-center justify-center gap-1">
  <svg width="27" height="27" viewBox="0 0 27 27" fill="none" aria-hidden="true"><path d="M5 5h17v17H5zM9 10h9M9 14h9M9 18h5" stroke="#69b8a2" strokeWidth="1.6" strokeLinejoin="round"/></svg>
  <span className="text-[11px] tracking-[.14em] font-bold">RSSD</span>
</Link>;

import { Metadata } from 'next';
import { RssdWorkspace } from '@gitroom/frontend/components/rssd/workspace';
export const metadata: Metadata = { title: 'RSSD 中心' };
export default function RssdPage() { return <RssdWorkspace />; }

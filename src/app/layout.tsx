import type { Metadata } from 'next';
import { WorkspaceProvider } from '@/components/workspace';
import './globals.css';
import './refresh-resolution.css';
import './refresh-other.css';
import './canvas.css';
import './redesign-resolution.css';
import './redesign-records.css';
import './redesign-templates.css';
import './redesign-returns.css';
// The page title is set per page by WorkspaceProvider ("Resolutions – CoSec Workspace").
export const metadata: Metadata = {
  description: 'Internal company secretarial workbench',
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WorkspaceProvider>{children}</WorkspaceProvider>
      </body>
    </html>
  );
}

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

const ADMIN_ROLES = ['admin', 'super_admin'];

/**
 * Server-side gate for every /admin page. The middleware already redirects
 * non-admins and sets `x-user-role`; this is a belt-and-braces check in case a
 * request reaches the layout without going through the middleware.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const role = (await headers()).get('x-user-role');
  if (!role || !ADMIN_ROLES.includes(role)) {
    redirect('/dashboard?denied=admin');
  }
  return <>{children}</>;
}

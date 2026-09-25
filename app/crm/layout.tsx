import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import CRMLayoutClient from './CRMLayoutClient';

const CRM_ROLES = ['admin', 'super_admin', 'instructor'];

/**
 * Server-side gate for every /crm page (belt-and-braces with the middleware,
 * which sets `x-user-role`). The sidebar UI lives in CRMLayoutClient.
 */
export default async function CRMLayout({ children }: { children: React.ReactNode }) {
  const role = (await headers()).get('x-user-role');
  if (!role || !CRM_ROLES.includes(role)) {
    redirect('/dashboard?denied=crm');
  }
  return <CRMLayoutClient>{children}</CRMLayoutClient>;
}

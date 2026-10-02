import { getCurrentUserAndProfile } from "@/lib/auth";
import { CompanyDiscovery } from "@/components/company-discovery";

export const dynamic = "force-dynamic";

/**
 * /company-discovery — Company & Email Discovery.
 *
 * Collects UNIQUE German companies (1 company = 1 result) with a publicly
 * published contact email for the user's field/role, across several public
 * sources, until the requested target count is reached or safe limits hit.
 * Auth gate mirrors /opportunities (server component; the client component
 * does the form + API interaction).
 */
export default async function CompanyDiscoveryPage() {
  const { profile } = await getCurrentUserAndProfile();
  if (!profile) return null;
  return (
    <div className="bg-background px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-4xl">
        <CompanyDiscovery />
      </div>
    </div>
  );
}

import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { exportUserData } from "@/lib/account-data";

/** GDPR data portability: server-side JSON export of the authenticated
 *  user's own data. The user id comes from the session only. */
export async function GET(): Promise<NextResponse> {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const exportData = await exportUserData(user.id);
  return new NextResponse(JSON.stringify(exportData, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="ausbildung-hunter-export-${new Date().toISOString().slice(0, 10)}.json"`,
      "cache-control": "no-store",
    },
  });
}

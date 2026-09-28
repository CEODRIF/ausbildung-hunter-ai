import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { deleteScan, updateCandidateProfile } from "@/lib/bewerbung-scanner";
import { candidateProfileSchema } from "@/lib/bewerbung-schema";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user } = await getCurrentUserAndProfile();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as {
    profile?: unknown;
  };
  const parsed = candidateProfileSchema.safeParse(body.profile);
  if (!parsed.success)
    return NextResponse.json(
      { error: "Invalid candidate profile." },
      { status: 400 },
    );
  try {
    const profile = await updateCandidateProfile(
      (await params).id,
      parsed.data,
    );
    return NextResponse.json(profile);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to save profile.",
      },
      { status: 400 },
    );
  }
}

/** Phase 16 — item-level erasure: delete the scan, its candidate
 *  profile (cascade), its scan-file rows (cascade), and any uploaded
 *  files that no other scan references (row + storage object). */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user } = await getCurrentUserAndProfile();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = (await params).id;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    return NextResponse.json({ error: "Scan not found." }, { status: 404 });
  try {
    const result = await deleteScan(id);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof Error && error.message === "Scan not found.")
      return NextResponse.json({ error: error.message }, { status: 404 });
    return NextResponse.json(
      { error: "Unable to delete scan." },
      { status: 500 },
    );
  }
}

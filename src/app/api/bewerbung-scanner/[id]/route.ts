import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { updateCandidateProfile } from "@/lib/bewerbung-scanner";
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

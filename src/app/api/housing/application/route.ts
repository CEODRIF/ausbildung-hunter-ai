import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { checkRateLimit, tooManyRequests } from "@/lib/rate-limit";
import {
  createApplication,
  deleteApplication,
  generateApplicationDraft,
  isApplicationStatus,
  listApplications,
  updateApplicationDraft,
  updateApplicationStatus,
  type ApplicationContext,
} from "@/lib/housing/application";
import { findListingById } from "@/lib/housing/providers";
import {
  createApplicationBodySchema,
  removeApplicationBodySchema,
  updateApplicationBodySchema,
} from "@/lib/housing/schema";

/**
 * /api/housing/application — prepared landlord messages.
 *
 * POST re-derives the listing server-side (provider + sourceId), generates the
 * draft (AI with a deterministic fallback), and persists it. Only the applicant's
 * OWN details come from the client.
 */

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Request failed.";
  const status = message === "Application not found." ? 404 : 500;
  return NextResponse.json({ error: message }, { status });
}

export async function GET() {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const applications = await listApplications(user.id);
    return NextResponse.json({ applications });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // One POST = one AI draft call (the expensive part).
  const limited = await checkRateLimit("housing_application_ai", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  let body;
  try {
    body = createApplicationBodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const listing = findListingById(body.provider, body.sourceId);
  if (!listing) {
    return NextResponse.json({ error: "Listing not found." }, { status: 404 });
  }

  const ctx: ApplicationContext = {
    firstName: body.context.firstName,
    lastName: body.context.lastName,
    occupation: body.context.occupation ?? null,
    moveInDate: body.context.moveInDate ?? null,
    note: body.context.note ?? null,
  };
  try {
    const draft = await generateApplicationDraft(listing, ctx);
    const application = await createApplication(
      user.id,
      listing,
      draft.text,
      body.title ?? listing.title,
    );
    return NextResponse.json({ application, ai_assisted: draft.ai_assisted });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body;
  try {
    body = updateApplicationBodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    if (body.status !== undefined && body.status !== null) {
      if (!isApplicationStatus(body.status)) {
        return NextResponse.json({ error: "Invalid status." }, { status: 400 });
      }
      const application = await updateApplicationStatus(user.id, body.id, body.status);
      return NextResponse.json({ application });
    }
    const application = await updateApplicationDraft(user.id, body.id, body.draft!);
    return NextResponse.json({ application });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body;
  try {
    body = removeApplicationBodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    await deleteApplication(user.id, body.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

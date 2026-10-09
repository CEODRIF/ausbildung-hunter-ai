import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { checkRateLimit, tooManyRequests } from "@/lib/rate-limit";
import {
  listSavedListings,
  listSavedSearches,
  removeSavedListing,
  removeSavedSearch,
  saveHousingListing,
  saveHousingSearch,
  updateSavedListingNotes,
  updateSavedListingStatus,
} from "@/lib/housing/saved";
import {
  deleteBodySchema,
  saveBodySchema,
  updateListingBodySchema,
} from "@/lib/housing/schema";

/**
 * /api/housing/save — the user's saved listings + saved searches.
 *
 * Contract (mirrors /api/opportunities/save): the client sends only ids and its
 * OWN notes/status/name; listing data is re-derived server-side, never trusted.
 * A `kind: "listing" | "search"` discriminator keeps both collections on one
 * route (the approved 4-route surface).
 */

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Request failed.";
  return NextResponse.json({ error: message }, { status: 500 });
}

export async function GET() {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const [listings, searches] = await Promise.all([
      listSavedListings(user.id),
      listSavedSearches(user.id),
    ]);
    return NextResponse.json({ listings, searches });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await checkRateLimit("housing_save", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  let body;
  try {
    body = saveBodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid save request." }, { status: 400 });
  }

  try {
    if (body.kind === "listing") {
      const saved = await saveHousingListing(
        user.id,
        body.provider,
        body.sourceId,
        body.notes ?? undefined,
      );
      return NextResponse.json({ saved });
    }
    const saved = await saveHousingSearch(
      user.id,
      body.name ?? null,
      body.query,
      body.lastCount ?? 0,
    );
    return NextResponse.json({ saved });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Save failed.";
    const status = message === "Listing not found." ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function PATCH(request: Request) {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body;
  try {
    body = updateListingBodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid update request." }, { status: 400 });
  }
  try {
    if (typeof body.notes === "string") {
      await updateSavedListingNotes(user.id, body.provider, body.sourceId, body.notes);
    }
    if (typeof body.status === "string") {
      await updateSavedListingStatus(user.id, body.provider, body.sourceId, body.status);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body;
  try {
    body = deleteBodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    if (body.kind === "listing") {
      await removeSavedListing(user.id, body.provider, body.sourceId);
    } else {
      await removeSavedSearch(user.id, body.id);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

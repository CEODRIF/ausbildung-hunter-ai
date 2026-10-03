import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

const STATE_COOKIE = "email_oauth_state";
const MAX_AGE_SECONDS = 600;

type OAuthState = {
  state: string;
  provider: "gmail" | "outlook";
  createdAt: number;
};

function stateSecret(): string {
  const configured =
    process.env.EMAIL_TOKEN_ENCRYPTION_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (configured) return configured;
  // A constant that is committed to the repository is not a secret: in
  // production it would let anyone forge a signed state value. Fail closed
  // there (consumeOAuthState turns the throw into "invalid state") and keep the
  // convenience fallback for local development only.
  if (process.env.NODE_ENV === "production")
    throw new Error(
      "Missing EMAIL_TOKEN_ENCRYPTION_KEY: cannot sign the OAuth state.",
    );
  return "local-development-state-secret";
}

function sign(value: string) {
  return createHash("sha256")
    .update(`${stateSecret()}:${value}`)
    .digest("base64url");
}

export async function createOAuthState(provider: OAuthState["provider"]) {
  const state = randomBytes(32).toString("base64url");
  const payload = JSON.stringify({ state, provider, createdAt: Date.now() });
  const signed = Buffer.from(
    JSON.stringify({ payload, signature: sign(payload) }),
  ).toString("base64url");
  const cookieStore = await cookies();
  cookieStore.set(STATE_COOKIE, signed, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: MAX_AGE_SECONDS,
    path: "/",
  });
  return state;
}

export async function consumeOAuthState(
  expectedProvider: OAuthState["provider"],
  submittedState: string | null,
) {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(STATE_COOKIE)?.value;
  cookieStore.delete(STATE_COOKIE);
  if (!cookieValue || !submittedState) return false;
  try {
    const { payload, signature } = JSON.parse(
      Buffer.from(cookieValue, "base64url").toString("utf8"),
    ) as { payload: string; signature: string };
    const expectedSignature = sign(payload);
    if (
      signature.length !== expectedSignature.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
    )
      return false;
    const parsed = JSON.parse(payload) as OAuthState;
    return (
      parsed.state === submittedState &&
      parsed.provider === expectedProvider &&
      Date.now() - parsed.createdAt <= MAX_AGE_SECONDS * 1000
    );
  } catch {
    return false;
  }
}

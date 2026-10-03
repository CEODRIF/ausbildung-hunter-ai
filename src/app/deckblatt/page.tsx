import { DeckblattGenerator } from "@/components/deckblatt-generator";

/**
 * /deckblatt — AI Deckblatt Generator.
 *
 * Server component that only mounts the client generator (auth + shell come
 * from the layout). All state, the photo (which never leaves the browser)
 * and the local rendering live in the client component.
 */
export default function DeckblattPage() {
  return <DeckblattGenerator />;
}

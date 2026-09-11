import type { PollAdapter } from "./base";
import { emersonAdapter } from "./emerson";

// ============================================================================
// Every pollster in config/pollsters.ts with a non-null adapterId must have an entry here.
// Right now that's just Emerson — see README "What's real vs. scaffold" for exactly why the
// other 12 aren't wired yet, and what each one specifically needs.
//
// Adding pollster #2: write adapters/<id>.ts implementing PollAdapter (see emerson.ts as the
// template — small parser, tested against a real fetched fixture, thrown AdapterError on
// genuine failure), then add one line here. Nothing else in the system changes.
// ============================================================================

export const ADAPTERS: Record<string, PollAdapter> = {
  emerson: emersonAdapter,
};

// ---------------------------------------------------------------------------
// Artifacts — saved generative-UI components. Row → public projection plus the
// operation inputs; the executor stitches these into `executor.artifacts` and
// the core `artifacts` HTTP group.
//
// An artifact IS the stored JSX source plus the title/description an agent
// matches against ("show me my active users dashboard"). Owner-scoped like a
// connection: created at the `user` tier, readable through the same owner
// policy, so org-tier sharing later needs no new machinery.
// ---------------------------------------------------------------------------

import type { ArtifactRow, ArtifactSummaryRow } from "./core-schema";
import { ArtifactId, type Owner } from "./ids";

export interface Artifact {
  readonly id: ArtifactId;
  readonly owner: Owner;
  readonly title: string;
  /** Model-supplied prose used for agent matching. Null when none was given. */
  readonly description: string | null;
  /** The JSX source. Only the full read carries it — lists stay light. */
  readonly code: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What a list returns: everything except the (potentially large) source. */
export type ArtifactSummary = Omit<Artifact, "code">;

/** Create a new artifact, or overwrite an existing one in place when `id` names
 *  one. v1 has no version history: a save replaces the stored source. */
export interface SaveArtifactInput {
  readonly id?: string;
  readonly title: string;
  readonly description?: string | null;
  readonly code: string;
}

export interface RenameArtifactInput {
  readonly id: string;
  readonly title: string;
}

export interface RemoveArtifactInput {
  readonly id: string;
}

const asDate = (value: Date | number | string): Date =>
  value instanceof Date ? value : new Date(value);

export const rowToArtifactSummary = (row: ArtifactSummaryRow): ArtifactSummary => ({
  id: ArtifactId.make(row.id),
  owner: row.owner as Owner,
  title: row.title,
  description: row.description ?? null,
  createdAt: asDate(row.created_at),
  updatedAt: asDate(row.updated_at),
});

export const rowToArtifact = (row: ArtifactRow): Artifact => ({
  ...rowToArtifactSummary(row),
  code: row.code,
});

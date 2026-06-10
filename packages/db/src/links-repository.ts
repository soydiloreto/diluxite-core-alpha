import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from './client';
import { noteLinks, notes } from './schema';

export interface GraphNode {
  id: string;
  title: string;
  /** Folder id the note belongs to (null = workspace root). Drives cluster colouring in the graph view. */
  folderId: string | null;
}
export interface GraphEdge {
  source: string;
  target: string;
}

export class DrizzleLinksRepository {
  constructor(private readonly db: Db) {}

  /** IDs of notes that link (`[[title]]`) to a note with the given title. */
  async backlinkIds(spaceId: string, title: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: noteLinks.noteId })
      .from(noteLinks)
      .where(and(eq(noteLinks.spaceId, spaceId), eq(noteLinks.target, title.toLowerCase())));
    return rows.map((r) => r.id);
  }

  /** Space graph: nodes = notes, edges = wikilinks resolving to existing notes. */
  async graph(spaceId: string): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    // Exclude trashed notes (deleted_at IS NOT NULL) from both nodes and the
    // source side of edges — otherwise soft-deleted notes still show up in the
    // graph. The target side is implicitly filtered: edges only resolve against
    // `byTitle`, which is built from the (already filtered) node set below.
    const nodes = await this.db
      .select({ id: notes.id, title: notes.title, folderId: notes.folderId })
      .from(notes)
      .where(and(eq(notes.spaceId, spaceId), isNull(notes.deletedAt)));
    const links = await this.db
      .select({ source: noteLinks.noteId, target: noteLinks.target })
      .from(noteLinks)
      .innerJoin(notes, eq(notes.id, noteLinks.noteId))
      .where(and(eq(noteLinks.spaceId, spaceId), isNull(notes.deletedAt)));

    const byTitle = new Map(nodes.map((n) => [n.title.toLowerCase(), n.id]));
    const edges: GraphEdge[] = [];
    for (const l of links) {
      const targetId = byTitle.get(l.target);
      if (targetId) edges.push({ source: l.source, target: targetId });
    }
    return { nodes, edges };
  }
}

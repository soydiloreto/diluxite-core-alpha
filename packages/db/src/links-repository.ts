import { and, eq } from 'drizzle-orm';
import type { Db } from './client';
import { noteLinks, notes } from './schema';

export interface GraphNode {
  id: string;
  title: string;
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
    const nodes = await this.db
      .select({ id: notes.id, title: notes.title })
      .from(notes)
      .where(eq(notes.spaceId, spaceId));
    const links = await this.db
      .select({ source: noteLinks.noteId, target: noteLinks.target })
      .from(noteLinks)
      .where(eq(noteLinks.spaceId, spaceId));

    const byTitle = new Map(nodes.map((n) => [n.title.toLowerCase(), n.id]));
    const edges: GraphEdge[] = [];
    for (const l of links) {
      const targetId = byTitle.get(l.target);
      if (targetId) edges.push({ source: l.source, target: targetId });
    }
    return { nodes, edges };
  }
}

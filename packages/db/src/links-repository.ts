import { and, eq } from 'drizzle-orm';
import type { Db } from './client';
import { notaLinks, notas } from './schema';

export interface GraphNode {
  id: string;
  titulo: string;
}
export interface GraphEdge {
  source: string;
  target: string;
}

export class DrizzleLinksRepository {
  constructor(private readonly db: Db) {}

  /** IDs de notas que enlazan (`[[título]]`) a la nota con ese título. */
  async backlinkIds(espacioId: string, titulo: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: notaLinks.notaId })
      .from(notaLinks)
      .where(and(eq(notaLinks.espacioId, espacioId), eq(notaLinks.target, titulo.toLowerCase())));
    return rows.map((r) => r.id);
  }

  /** Grafo del espacio: nodos = notas, aristas = wikilinks que apuntan a notas existentes. */
  async graph(espacioId: string): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const nodes = await this.db
      .select({ id: notas.id, titulo: notas.titulo })
      .from(notas)
      .where(eq(notas.espacioId, espacioId));
    const links = await this.db
      .select({ source: notaLinks.notaId, target: notaLinks.target })
      .from(notaLinks)
      .where(eq(notaLinks.espacioId, espacioId));

    const byTitulo = new Map(nodes.map((n) => [n.titulo.toLowerCase(), n.id]));
    const edges: GraphEdge[] = [];
    for (const l of links) {
      const targetId = byTitulo.get(l.target);
      if (targetId) edges.push({ source: l.source, target: targetId });
    }
    return { nodes, edges };
  }
}

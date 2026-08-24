export interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
}

export interface FolderStore {
  list(spaceId: string): Promise<FolderNode[]>;
  create(spaceId: string, name: string, parentId: string | null): Promise<FolderNode>;
}

export const FOLDER_PATH_SEPARATOR = '/';

/**
 * "Dailies//2026-08/ " → ["Dailies", "2026-08"]. Blank segments are dropped so
 * a leading, trailing or doubled separator is not an error — a caller building
 * the path by concatenation shouldn't have to normalise first.
 */
export function splitFolderPath(path: string): string[] {
  return path
    .split(FOLDER_PATH_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * Resolve a folder path to its id, creating the segments that don't exist yet
 * (`mkdir -p`). An empty path means the space root, which is `null`.
 *
 * Sibling names are matched case-insensitively: a caller that writes "dailies"
 * one day and "Dailies" the next means the same folder, and there is no unique
 * index to stop the second one from becoming a duplicate. When a space already
 * holds siblings that differ only by case, the first by name wins so repeated
 * calls keep landing in the same place.
 */
export async function resolveFolderPath(
  store: FolderStore,
  spaceId: string,
  path: string | null | undefined,
): Promise<string | null> {
  const segments = path ? splitFolderPath(path) : [];
  if (segments.length === 0) return null;

  const all = await store.list(spaceId);
  const childrenOf = new Map<string | null, FolderNode[]>();
  for (const folder of all) {
    const siblings = childrenOf.get(folder.parentId) ?? [];
    siblings.push(folder);
    childrenOf.set(folder.parentId, siblings);
  }

  let parentId: string | null = null;
  for (const segment of segments) {
    const siblings = (childrenOf.get(parentId) ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    const match = siblings.find((f) => f.name.trim().toLowerCase() === segment.toLowerCase());
    if (match) {
      parentId = match.id;
      continue;
    }
    const created = await store.create(spaceId, segment, parentId);
    // Keep the local index in step: two new segments in a row must nest, not
    // land side by side off the same parent.
    childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), created]);
    parentId = created.id;
  }
  return parentId;
}

/**
 * The human-readable path of a folder ("Dailies/2026-08"), for telling a caller
 * where its note actually ended up. The root is an empty string. Defensive
 * against a broken parent chain: a cycle stops instead of hanging.
 */
export function folderPathOf(folders: FolderNode[], folderId: string | null): string {
  if (folderId === null) return '';
  const byId = new Map(folders.map((f) => [f.id, f]));
  const parts: string[] = [];
  const seen = new Set<string>();
  let current: string | null = folderId;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const folder: FolderNode | undefined = byId.get(current);
    if (!folder) break;
    parts.unshift(folder.name);
    current = folder.parentId;
  }
  return parts.join(FOLDER_PATH_SEPARATOR);
}

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
 * Every folder as a full path, sorted so a child always follows its parent.
 * This is the shape a caller needs to SEE the tree — the tools address folders
 * by path, so ids would be noise.
 */
export function folderPaths(folders: FolderNode[]): { id: string; path: string }[] {
  return folders
    .map((f) => ({ id: f.id, path: folderPathOf(folders, f.id) }))
    .filter((f) => f.path !== '')
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Look a path up WITHOUT creating anything — the counterpart of
 * resolveFolderPath for callers that must not conjure a folder to operate on
 * it (deleting, reporting). Returns null when any segment is missing. An empty
 * path is null too: the root is not a folder you can act on.
 */
export function findFolderPath(folders: FolderNode[], path: string): FolderNode | null {
  const segments = splitFolderPath(path);
  if (segments.length === 0) return null;

  let parentId: string | null = null;
  let found: FolderNode | null = null;
  for (const segment of segments) {
    const siblings = folders
      .filter((f) => f.parentId === parentId)
      .sort((a, b) => a.name.localeCompare(b.name));
    const match = siblings.find((f) => f.name.trim().toLowerCase() === segment.toLowerCase());
    if (!match) return null;
    found = match;
    parentId = match.id;
  }
  return found;
}

/**
 * A folder plus every folder under it. Deleting cascades in the database, so
 * this is what a caller needs to say out loud BEFORE deleting: how much is
 * about to go. Cycle-safe.
 */
export function descendantFolderIds(folders: FolderNode[], rootId: string): string[] {
  const childrenOf = new Map<string | null, FolderNode[]>();
  for (const folder of folders) {
    const siblings = childrenOf.get(folder.parentId) ?? [];
    siblings.push(folder);
    childrenOf.set(folder.parentId, siblings);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const child of childrenOf.get(id) ?? []) stack.push(child.id);
  }
  return out;
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

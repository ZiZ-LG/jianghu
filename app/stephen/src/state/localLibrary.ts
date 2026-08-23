import type { LocalLibraryState, ToolMaterial } from '../domain';

export const LIBRARY_STORAGE_KEY = 'stephen-knowledge-library-v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface LibraryScope {
  readonly itemIds: readonly string[];
  readonly toolIds: readonly string[];
  readonly now: string;
}

function uniqueValidIds(value: unknown, validIds: ReadonlySet<string>) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string =>
    typeof id === 'string' && validIds.has(id)))];
}

function validStatus(value: unknown): value is ToolMaterial['status'] {
  return value === 'not_started' || value === 'in_progress' || value === 'completed';
}

function normalizeToolMaterials(value: unknown, validToolIds: ReadonlySet<string>) {
  if (!Array.isArray(value)) return [];
  const materials = new Map<string, ToolMaterial>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    const material = candidate as Partial<ToolMaterial>;
    if (
      typeof material.toolId !== 'string'
      || !validToolIds.has(material.toolId)
      || typeof material.title !== 'string'
      || typeof material.bodyMarkdown !== 'string'
      || typeof material.updatedAt !== 'string'
      || !validStatus(material.status)
    ) {
      continue;
    }
    materials.set(material.toolId, {
      toolId: material.toolId,
      title: material.title,
      status: material.status,
      bodyMarkdown: material.bodyMarkdown,
      updatedAt: material.updatedAt,
    });
  }
  return [...materials.values()];
}

export function createEmptyLibraryState(now = new Date().toISOString()): LocalLibraryState {
  return {
    version: 1,
    bookmarkedIds: [],
    readIds: [],
    toolMaterials: [],
    updatedAt: now,
  };
}

export function loadLibraryState(
  storage: StorageLike,
  { itemIds, toolIds, now }: LibraryScope,
): LocalLibraryState {
  const raw = storage.getItem(LIBRARY_STORAGE_KEY);
  if (raw === null) return createEmptyLibraryState(now);

  try {
    const parsed = JSON.parse(raw) as Partial<LocalLibraryState> | null;
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid local library');
    const validItemIds = new Set(itemIds);
    const validToolIds = new Set(toolIds);
    return {
      version: 1,
      bookmarkedIds: uniqueValidIds(parsed.bookmarkedIds, validItemIds),
      readIds: uniqueValidIds(parsed.readIds, validItemIds),
      toolMaterials: normalizeToolMaterials(parsed.toolMaterials, validToolIds),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : now,
    };
  } catch {
    storage.removeItem(LIBRARY_STORAGE_KEY);
    return createEmptyLibraryState(now);
  }
}

export function saveLibraryState(storage: StorageLike, state: LocalLibraryState) {
  try {
    storage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function clearLibraryState(storage: StorageLike) {
  storage.removeItem(LIBRARY_STORAGE_KEY);
}

export function setBookmark(
  state: LocalLibraryState,
  itemId: string,
  bookmarked: boolean,
  validItemIds: readonly string[],
  now = new Date().toISOString(),
): LocalLibraryState {
  if (!validItemIds.includes(itemId)) return state;
  const ids = new Set(state.bookmarkedIds);
  if (bookmarked) ids.add(itemId);
  else ids.delete(itemId);
  return { ...state, bookmarkedIds: [...ids], updatedAt: now };
}

export function toggleBookmark(
  state: LocalLibraryState,
  itemId: string,
  validItemIds: readonly string[],
  now = new Date().toISOString(),
) {
  return setBookmark(state, itemId, !state.bookmarkedIds.includes(itemId), validItemIds, now);
}

export function markRead(
  state: LocalLibraryState,
  itemId: string,
  validItemIds: readonly string[],
  now = new Date().toISOString(),
): LocalLibraryState {
  if (!validItemIds.includes(itemId) || state.readIds.includes(itemId)) return state;
  return { ...state, readIds: [...state.readIds, itemId], updatedAt: now };
}

export function upsertToolMaterial(
  state: LocalLibraryState,
  material: Omit<ToolMaterial, 'updatedAt'>,
  validToolIds: readonly string[],
  now = new Date().toISOString(),
): LocalLibraryState {
  if (!validToolIds.includes(material.toolId)) return state;
  const next: ToolMaterial = { ...material, updatedAt: now };
  const existingIndex = state.toolMaterials.findIndex((entry) => entry.toolId === material.toolId);
  const toolMaterials = [...state.toolMaterials];
  if (existingIndex === -1) toolMaterials.push(next);
  else toolMaterials[existingIndex] = next;
  return { ...state, toolMaterials, updatedAt: now };
}

export function removeToolMaterial(
  state: LocalLibraryState,
  toolId: string,
  now = new Date().toISOString(),
): LocalLibraryState {
  const toolMaterials = state.toolMaterials.filter((entry) => entry.toolId !== toolId);
  if (toolMaterials.length === state.toolMaterials.length) return state;
  return { ...state, toolMaterials, updatedAt: now };
}

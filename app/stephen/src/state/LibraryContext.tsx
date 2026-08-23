import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import type { LocalLibraryState, ToolMaterial } from '../domain';
import {
  clearLibraryState,
  createEmptyLibraryState,
  loadLibraryState,
  markRead as markReadState,
  removeToolMaterial as removeToolMaterialState,
  saveLibraryState,
  toggleBookmark as toggleBookmarkState,
  upsertToolMaterial,
} from './localLibrary';

interface LibraryContextValue {
  readonly state: LocalLibraryState;
  readonly saveStatus: 'saved' | 'error';
  readonly toggleBookmark: (itemId: string) => void;
  readonly markRead: (itemId: string) => void;
  readonly updateToolMaterial: (
    material: Omit<ToolMaterial, 'updatedAt'>,
  ) => void;
  readonly removeToolMaterial: (toolId: string) => void;
  readonly clearAll: () => void;
}

const fallbackState = createEmptyLibraryState('1970-01-01T00:00:00.000Z');
const LibraryContext = createContext<LibraryContextValue>({
  state: fallbackState,
  saveStatus: 'saved',
  toggleBookmark: () => undefined,
  markRead: () => undefined,
  updateToolMaterial: () => undefined,
  removeToolMaterial: () => undefined,
  clearAll: () => undefined,
});

export function LibraryProvider({
  itemIds,
  toolIds,
  children,
}: {
  readonly itemIds: readonly string[];
  readonly toolIds: readonly string[];
  readonly children: ReactNode;
}) {
  const [state, setState] = useState<LocalLibraryState>(() => {
    if (typeof window === 'undefined') return createEmptyLibraryState();
    return loadLibraryState(window.localStorage, {
      itemIds,
      toolIds,
      now: new Date().toISOString(),
    });
  });
  const [saveStatus, setSaveStatus] = useState<'saved' | 'error'>('saved');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setSaveStatus(saveLibraryState(window.localStorage, state) ? 'saved' : 'error');
  }, [state]);

  const toggleBookmark = useCallback((itemId: string) => {
    setState((current) => toggleBookmarkState(current, itemId, itemIds));
  }, [itemIds]);

  const markRead = useCallback((itemId: string) => {
    setState((current) => markReadState(current, itemId, itemIds));
  }, [itemIds]);

  const updateToolMaterial = useCallback((material: Omit<ToolMaterial, 'updatedAt'>) => {
    setState((current) => upsertToolMaterial(current, material, toolIds));
  }, [toolIds]);

  const removeToolMaterial = useCallback((toolId: string) => {
    setState((current) => removeToolMaterialState(current, toolId));
  }, []);

  const clearAll = useCallback(() => {
    if (typeof window !== 'undefined') clearLibraryState(window.localStorage);
    setState(createEmptyLibraryState());
  }, []);

  const value = useMemo<LibraryContextValue>(() => ({
    state,
    saveStatus,
    toggleBookmark,
    markRead,
    updateToolMaterial,
    removeToolMaterial,
    clearAll,
  }), [
    clearAll,
    markRead,
    removeToolMaterial,
    saveStatus,
    state,
    toggleBookmark,
    updateToolMaterial,
  ]);

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary() {
  return useContext(LibraryContext);
}

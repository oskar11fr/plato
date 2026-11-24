// Messages between panes, keyed by document path. If no pane is listening
// yet (e.g. the chat pane is still opening), the latest message waits and is
// delivered when one subscribes.

type Listener<T> = (value: T) => void;

class PaneChannel<T> {
  private listeners = new Map<string, Set<Listener<T>>>();
  private pending = new Map<string, T>();

  emit(key: string, value: T) {
    const ls = this.listeners.get(key);
    if (ls && ls.size > 0) ls.forEach((l) => l(value));
    else this.pending.set(key, value);
  }

  subscribe(key: string, listener: Listener<T>): () => void {
    let ls = this.listeners.get(key);
    if (!ls) this.listeners.set(key, (ls = new Set()));
    ls.add(listener);
    if (this.pending.has(key)) {
      const value = this.pending.get(key) as T;
      this.pending.delete(key);
      listener(value);
    }
    return () => {
      ls.delete(listener);
    };
  }
}

/** A passage selected in a document, sent to that document's chat. */
export interface PassageAttachment {
  highlightId: string;
  page: number;
  quote: string;
  /** Full text of the page, sent once as context with the question. */
  pageText: string;
}

/** Ask AI: attach a passage to the document's chat. */
export const passageToChat = new PaneChannel<PassageAttachment>();

/** Scroll a document's viewer to a highlight, or just to a page. */
export const revealHighlight = new PaneChannel<{ highlightId?: string; page: number }>();

/** Show a specific saved chat in the document's chat pane. */
export const showChat = new PaneChannel<string>();

/** A pane changed files in the workspace (e.g. saved a wiki page); the sidebar refreshes. */
type FilesListener = (changed: string[]) => void;
const filesListeners = new Set<FilesListener>();
export const filesChanged = {
  emit: (changed: string[]) => filesListeners.forEach((l) => l(changed)),
  subscribe(listener: FilesListener): () => void {
    filesListeners.add(listener);
    return () => void filesListeners.delete(listener);
  },
};

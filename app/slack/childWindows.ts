import { byName, patchFunctionExport } from './webpack'

const documents = new Set<Document>()

type ChildWindowListener = (doc: Document) => void
const listeners = new Set<ChildWindowListener>()

function prune() {
  for (const doc of documents) {
    const win = doc.defaultView
    if (!win || win.closed) documents.delete(doc)
  }
}

export function childWindowDocuments(): Document[] {
  prune()
  return [...documents]
}

/** runs for every child window document, present and future */
export function onChildWindow(listener: ChildWindowListener): () => void {
  listeners.add(listener)
  for (const doc of childWindowDocuments()) {
    try {
      listener(doc)
    } catch {}
  }
  return () => listeners.delete(listener)
}

function register(doc: Document) {
  if (documents.has(doc)) return
  documents.add(doc)
  doc.defaultView?.addEventListener('pagehide', () => documents.delete(doc), {
    once: true,
  })
  for (const listener of listeners) {
    try {
      listener(doc)
    } catch {}
  }
}

// Slack runs this once per child window, after its doctype settles and before React renders into it
patchFunctionExport(
  byName('copyDocumentStylesheets'),
  (original) =>
    async function copyDocumentStylesheets(source: Document, target: Document) {
      const result = await original(source, target)
      try {
        register(target)
      } catch {}
      return result
    }
)

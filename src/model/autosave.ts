import type { Project, RenderData } from "./types";

const DATABASE = "political-map-studio", STORE = "projects", DATA_STORE = "datasets", KEY = "autosave";
type StoredProject = Omit<Project, "renderData" | "comparison"> & { renderDataKey: IDBValidKey; comparison?: StoredProject };
type Snapshot = { format: "split-data-v1"; project: StoredProject };
const dataKeys = new WeakMap<RenderData, IDBValidKey>();
let saveQueue: Promise<void> = Promise.resolve();

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
      if (!database.objectStoreNames.contains(DATA_STORE)) database.createObjectStore(DATA_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export type AutosaveInfo = Pick<Project, "metadata" | "modifiedAt">;

/** The library needs a recovery label, not tens of megabytes of precinct coordinates. */
export async function loadAutosaveInfo(): Promise<AutosaveInfo | undefined> {
  const database = await openDatabase();
  let saved: Project | Snapshot | undefined;
  try {
    saved = await result<Project | Snapshot | undefined>(database.transaction(STORE).objectStore(STORE).get(KEY));
  } finally {
    database.close();
  }
  if (!saved) {
    const legacy = localStorage.getItem("pmap.autosave");
    if (legacy) saved = JSON.parse(legacy) as Project;
  }
  if (!saved) return undefined;
  const project = "format" in saved && saved.format === "split-data-v1" ? (saved as Snapshot).project : saved as Project;
  if (typeof project.metadata?.title !== "string" || typeof project.modifiedAt !== "string") throw new Error("Stored autosave metadata is invalid; the stored project was not changed.");
  return { metadata: project.metadata, modifiedAt: project.modifiedAt };
}

/** Restore the self-contained public project; the split format stays private to IndexedDB. */
export async function loadAutosave(): Promise<Project | undefined> {
  let database: IDBDatabase | undefined;
  try {
    database = await openDatabase();
    const transaction = database.transaction([STORE, DATA_STORE]);
    const saved = await result<Project | Snapshot | undefined>(transaction.objectStore(STORE).get(KEY));
    if (saved) {
      // Existing full-project autosaves upgrade atomically on the next successful save.
      if (!("format" in saved) || saved.format !== "split-data-v1") return saved as Project;
      const stored = (saved as Snapshot).project;
      const keys = new Set<IDBValidKey>();
      const collect = (project: StoredProject) => {
        keys.add(project.renderDataKey);
        if (project.comparison) collect(project.comparison);
      };
      collect(stored);
      const store = transaction.objectStore(DATA_STORE);
      const entries = await Promise.all([...keys].map(async key => [key, await result<RenderData | undefined>(store.get(key))] as const));
      const datasets = new Map(entries);
      const restore = ({ renderDataKey, comparison, ...project }: StoredProject): Project => {
        const renderData = datasets.get(renderDataKey);
        if (!renderData) throw new Error("Autosave is missing its matched dataset; the stored project was not changed.");
        dataKeys.set(renderData, renderDataKey);
        return { ...project, renderData, ...(comparison ? { comparison: restore(comparison) } : {}) };
      };
      return restore(stored);
    }
  } catch (error) {
    if (!localStorage.getItem("pmap.autosave")) throw error;
  } finally {
    database?.close();
  }
  const legacy = localStorage.getItem("pmap.autosave");
  if (!legacy) return undefined;
  const project = JSON.parse(legacy) as Project;
  await saveAutosave(project);
  localStorage.removeItem("pmap.autosave");
  return project;
}

async function writeSnapshot(project: Project): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction([STORE, DATA_STORE], "readwrite");
    const complete = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("Autosave transaction aborted"));
      transaction.onerror = () => reject(transaction.error);
    });
    // Observe rejection immediately even if a request fails before we reach the final await.
    void complete.catch(() => {});
    try {
      const store = transaction.objectStore(DATA_STORE);
      const existing = new Set(await result(store.getAllKeys()));
      const retained = new Set<IDBValidKey>();
      const pack = async ({ renderData, comparison, ...document }: Project): Promise<StoredProject> => {
        let key = dataKeys.get(renderData);
        if (key === undefined || !existing.has(key)) {
          key = crypto.randomUUID();
          await result(store.add(renderData, key));
          dataKeys.set(renderData, key);
          existing.add(key);
        }
        retained.add(key);
        return { ...document, renderDataKey: key, ...(comparison ? { comparison: await pack(comparison) } : {}) };
      };
      const snapshot: Snapshot = { format: "split-data-v1", project: await pack(project) };
      transaction.objectStore(STORE).put(snapshot, KEY);
      for (const key of existing) if (!retained.has(key)) store.delete(key);
      await complete;
    } catch (error) {
      try { transaction.abort(); } catch { /* A failed transaction may already be finished. */ }
      throw error;
    }
  } finally {
    database.close();
  }
}

/** Geometry/records are written once per immutable dataset, not again for every style edit. */
export function saveAutosave(project: Project): Promise<void> {
  const saved = saveQueue.then(() => writeSnapshot(project));
  saveQueue = saved.catch(() => {});
  return saved;
}

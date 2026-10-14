import { uploadObjectFn } from "../api/objects/uploadObjectFn";
import { useQueryClient } from "@tanstack/react-query";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

const MAX_CONCURRENT_UPLOADS = 5;

export type UploadStatus = "pending" | "uploading" | "completed" | "failed";

export interface TrackedUpload {
  id: string;
  /** Short display name for the tracker UI (usually the filename). */
  displayName: string;
  /** Full object key including any prefix — what the server will store it as. */
  objectKey: string;
  bucketName: string;
  sizeBytes: number;
  status: UploadStatus;
  errorMessage?: string;
}

export interface EnqueueItem {
  file: File;
  bucketName: string;
  objectKey: string;
  /** Optional display override; defaults to file.name. */
  displayName?: string;
}

interface UploadTrackerContextValue {
  uploads: TrackedUpload[];
  enqueueUploads: (items: EnqueueItem[]) => void;
  /** Remove a single entry from the tracker regardless of status. */
  dismiss: (id: string) => void;
  /** Remove all completed/failed entries, keep in-flight. */
  clearFinished: () => void;
  /** Remove every entry. */
  clearAll: () => void;
}

const UploadTrackerContext = createContext<UploadTrackerContextValue | null>(
  null
);

interface QueuedJob {
  id: string;
  file: File;
  bucketName: string;
  objectKey: string;
}

const makeId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const UploadTrackerProvider = ({
  children,
}: {
  children: ReactNode;
}) => {
  const axios = useAxios("fileService");
  const queryClient = useQueryClient();
  const axiosRef = useRef(axios);
  axiosRef.current = axios;
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;

  // Display state — one entry per tracked upload.
  const [uploads, setUploads] = useState<TrackedUpload[]>([]);

  // Execution queue — decoupled from React state so we can pop synchronously
  // inside pump() without waiting for renders to flush. Holds the raw File
  // handle alongside destination info.
  const queueRef = useRef<QueuedJob[]>([]);
  const inFlightRef = useRef(0);

  const updateUpload = useCallback(
    (id: string, patch: Partial<TrackedUpload>) => {
      setUploads((prev) =>
        prev.map((u) => (u.id === id ? { ...u, ...patch } : u))
      );
    },
    []
  );

  const invalidateAfterUpload = useCallback((bucketName: string) => {
    const qc = queryClientRef.current;
    qc.invalidateQueries({ queryKey: [`objects-${bucketName}-infinite`] });
    qc.invalidateQueries({ queryKey: ["object-prefixes", bucketName] });
    // Version caches are keyed by object id, which a key-based upload
    // doesn't know — refresh the bucket's.
    qc.invalidateQueries({ queryKey: ["object-versions", bucketName] });
    qc.invalidateQueries({ queryKey: ["buckets"] });
    qc.invalidateQueries({ queryKey: ["buckets-infinite"] });
    qc.invalidateQueries({ queryKey: ["bucket", bucketName] });
  }, []);

  const pump = useCallback(() => {
    while (
      inFlightRef.current < MAX_CONCURRENT_UPLOADS &&
      queueRef.current.length > 0
    ) {
      const job = queueRef.current.shift()!;
      inFlightRef.current++;
      updateUpload(job.id, { status: "uploading" });
      uploadObjectFn(axiosRef.current, {
        bucketName: job.bucketName,
        objectKey: job.objectKey,
        file: job.file,
      })
        .then(() => {
          updateUpload(job.id, { status: "completed" });
          invalidateAfterUpload(job.bucketName);
        })
        .catch((err: unknown) => {
          const axiosErr = err as AxiosError<{ error_description?: string }>;
          const message =
            axiosErr.response?.data?.error_description ||
            (err instanceof Error ? err.message : "Upload failed");
          updateUpload(job.id, { status: "failed", errorMessage: message });
        })
        .finally(() => {
          inFlightRef.current--;
          pump();
        });
    }
  }, [updateUpload, invalidateAfterUpload]);

  const enqueueUploads = useCallback(
    (items: EnqueueItem[]) => {
      if (items.length === 0) return;
      const tracked: TrackedUpload[] = items.map((item) => ({
        id: makeId(),
        displayName: item.displayName ?? item.file.name,
        objectKey: item.objectKey,
        bucketName: item.bucketName,
        sizeBytes: item.file.size,
        status: "pending",
      }));
      setUploads((prev) => [...prev, ...tracked]);
      for (let i = 0; i < items.length; i++) {
        queueRef.current.push({
          id: tracked[i].id,
          file: items[i].file,
          bucketName: items[i].bucketName,
          objectKey: items[i].objectKey,
        });
      }
      pump();
    },
    [pump]
  );

  const dismiss = useCallback((id: string) => {
    setUploads((prev) => prev.filter((u) => u.id !== id));
  }, []);

  const clearFinished = useCallback(() => {
    setUploads((prev) =>
      prev.filter((u) => u.status !== "completed" && u.status !== "failed")
    );
  }, []);

  const clearAll = useCallback(() => {
    setUploads([]);
  }, []);

  return (
    <UploadTrackerContext.Provider
      value={{
        uploads,
        enqueueUploads,
        dismiss,
        clearFinished,
        clearAll,
      }}
    >
      {children}
    </UploadTrackerContext.Provider>
  );
};

export const useUploadTracker = (): UploadTrackerContextValue => {
  const ctx = useContext(UploadTrackerContext);
  if (!ctx) {
    throw new Error(
      "useUploadTracker must be used inside an UploadTrackerProvider"
    );
  }
  return ctx;
};

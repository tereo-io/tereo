import { FileStorageSidebar } from "../layouts/FileStorageSidebar";
import { UploadTrackerProvider } from "@/features/file-storage";
import { Navigate, type RouteObject } from "react-router-dom";
import { SectionLayout } from "../layouts/SectionLayout";
import { UploadTracker } from "@/features/file-storage";
import { RequireAuth } from "@/features/auth";
import { namedLazy } from "./lazy";

const canRead = (element: React.ReactNode) => (
  <RequireAuth requiredPermission="file-service.buckets.read">
    {element}
  </RequireAuth>
);

const fileStorageElement = (
  <UploadTrackerProvider>
    <SectionLayout title="File Storage" sidebar={<FileStorageSidebar />} />
    <UploadTracker />
  </UploadTrackerProvider>
);

export const fileStorageRoute: RouteObject = {
  path: "file-storage",
  element: fileStorageElement,
  handle: { title: "File Storage" },
  children: [
    {
      index: true,
      element: <Navigate to="/file-storage/buckets" replace />,
    },
    {
      path: "buckets",
      handle: { title: "Buckets" },
      element: canRead(
        namedLazy(
          () => import("@/features/file-storage/components/buckets/BucketList"),
          "BucketList"
        )
      ),
    },
    {
      path: "buckets/:bucketName",
      element: canRead(
        namedLazy(
          () =>
            import("@/features/file-storage/components/buckets/BucketDetail"),
          "BucketDetail"
        )
      ),
    },
  ],
};

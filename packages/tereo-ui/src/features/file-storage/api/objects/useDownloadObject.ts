import triggerArchiveDownload from "../archives/triggerArchiveDownload";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

/** Long enough to start the download; the URL is used once, right away. */
const DOWNLOAD_URL_TTL_SECONDS = 60;

/**
 * The URL a download navigates to: forced to an attachment, so the browser
 * saves it under core's filename rather than opening an inline type.
 */
const attachmentUrl = (signedUrl: string): string => {
  const url = new URL(signedUrl);
  url.searchParams.set("disposition", "attachment");
  return url.toString();
};

/**
 * Downloads an object through a short-lived presigned URL, which the browser
 * fetches itself and streams to disk — fetching it here as a blob would hold
 * the whole file in memory, and a bearer token cannot ride on a navigation.
 */
const useDownloadObject = () => {
  const axios = useAxios("fileService");

  const downloadObject = async (bucketName: string, objectId: string) => {
    try {
      const res = await axios.post<{ url: string }>(
        `/buckets/${bucketName}/objects/by-id/${objectId}/presign`,
        { operation: "read", expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS }
      );
      triggerArchiveDownload(attachmentUrl(res.data.url));
    } catch (error: unknown) {
      const axiosError = error as AxiosError<{
        error_description?: string;
      }>;
      toast.error(
        axiosError.response?.data?.error_description ||
          "Failed to download object"
      );
    }
  };

  return { downloadObject };
};

export default useDownloadObject;

/**
 * Trigger a native-browser download for a signed archive URL. Uses an
 * anchor-click so the server-provided `Content-Disposition` filename is
 * honored (unlike `responseType: "blob"` flows where we have to guess the
 * name from the path). Same origin check not applied — the URL is produced
 * by our own service and already scoped by the HMAC.
 */
const triggerArchiveDownload = (url: string) => {
  const link = document.createElement("a");
  link.href = url;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
};

export default triggerArchiveDownload;

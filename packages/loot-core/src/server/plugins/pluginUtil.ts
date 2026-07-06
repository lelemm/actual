import { safeUnzip } from '#server/util/zip';

export async function extractZipToMap(
  zipBlob: ArrayBuffer | Uint8Array | Blob,
) {
  const zipData =
    zipBlob instanceof Blob ? await zipBlob.arrayBuffer() : zipBlob;
  const zip = safeUnzip(new Uint8Array(zipData));
  const fileMap = new Map();
  const decoder = new TextDecoder();

  for (const [filePath, content] of Object.entries(zip)) {
    fileMap.set(filePath, decoder.decode(content));
  }

  return fileMap;
}

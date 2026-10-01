import { createHash } from "crypto";
import { createReadStream } from "fs";
import { PaperlessAPI } from "../../api/PaperlessAPI";

export type ChecksumAlgorithm = "sha256" | "md5";

export interface DuplicateDocument {
  id: number;
  title: string;
}

interface ChecksumRow {
  id: number;
  checksum?: string;
}

const MD5_HEX_LENGTH = 32;

/**
 * Paperless-ngx 2.x hashes the original file with SHA-256 (64 hex characters);
 * older instances used MD5 (32). The format is read from the newest document.
 */
export async function detectChecksumAlgorithm(
  api: PaperlessAPI
): Promise<ChecksumAlgorithm> {
  const response = await api.getDocuments(
    "?page_size=1&ordering=-id&fields=id,checksum"
  );
  const row = response.results[0] as ChecksumRow | undefined;
  if (!row) return "sha256";

  let checksum = row.checksum;
  if (!checksum) {
    const metadata = await api.request<{ original_checksum?: string }>(
      `/documents/${row.id}/metadata/`
    );
    checksum = metadata.original_checksum;
  }
  return checksum?.length === MD5_HEX_LENGTH ? "md5" : "sha256";
}

export async function fileChecksum(
  filePath: string,
  algorithm: ChecksumAlgorithm
): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export function bufferChecksum(
  data: Buffer,
  algorithm: ChecksumAlgorithm
): string {
  return createHash(algorithm).update(data).digest("hex");
}

export async function findDocumentByChecksum(
  api: PaperlessAPI,
  checksum: string
): Promise<DuplicateDocument | null> {
  const response = await api.getDocuments(
    `?checksum__iexact=${encodeURIComponent(checksum)}&fields=id,title,original_file_name&page_size=1`
  );
  const match = response.results[0];
  return match ? { id: match.id, title: match.title } : null;
}

const MiB = 1024 * 1024;

// Shared by both local upload endpoints; recognition fingerprints include this file.
export const uploadLimits = Object.freeze({
  fileBytes: 100 * MiB,
  entryBytes: 512 * MiB,
  totalBytes: 1024 * MiB,
  entries: 10_000,
  rows: 1_000_000,
  columns: 512,
});

export const formatUploadMB = bytes => `${Number((bytes / MiB).toFixed(6))} MB`;
export const uploadSizeError = bytes => `上传文件大小为 ${formatUploadMB(bytes)}，超过 ${uploadLimits.fileBytes / MiB} MB 上限。请保留所需完整数据并整理文件；多次上传不会合并。`;

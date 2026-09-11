import SparkMD5 from 'spark-md5'

/** Yield between chunks so hashing large folders does not freeze cancel/progress controls. */
export async function hashUploadFile(file: Blob, signal: AbortSignal): Promise<string> {
  const hash = new SparkMD5.ArrayBuffer()
  try {
    for (let offset = 0; offset < file.size; offset += 2 * 1024 * 1024) {
      signal.throwIfAborted()
      hash.append(await file.slice(offset, offset + 2 * 1024 * 1024).arrayBuffer())
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    signal.throwIfAborted()
    return hash.end()
  } finally { hash.destroy() }
}

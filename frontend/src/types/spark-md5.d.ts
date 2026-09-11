declare module 'spark-md5' {
  class ArrayBufferHash {
    append(value: ArrayBuffer): this
    end(): string
    destroy(): void
  }
  const SparkMD5: { ArrayBuffer: typeof ArrayBufferHash }
  export default SparkMD5
}

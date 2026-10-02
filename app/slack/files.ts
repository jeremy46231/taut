import { dispatchThunk } from './redux'

type PendingUpload = { uploadPromise?: Promise<{ fileIds?: string[] }> }

/** resolves with the file id, pass a real File since Slack reads `subtype` off it and sets `id` on it */
export async function uploadFile(file: File): Promise<string> {
  const pending: PendingUpload = await dispatchThunk(
    'addAndUploadPendingFile',
    { file, hideBanner: true }
  )
  const fileId = (await pending?.uploadPromise)?.fileIds?.[0]
  if (!fileId) throw new Error('[Taut] Slack rejected the upload')
  return fileId
}

export const filesPromise = (async () => {
  return { upload: uploadFile }
})()

export type FilesAPI = Awaited<typeof filesPromise>

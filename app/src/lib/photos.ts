// Photos → Supabase Storage (private bucket "photos"), compressed in the browser to ≤1280 px JPEG 0.7 (SPEC §1.7).
// Never stored as base64 in the database; read back with short-lived signed URLs.
import imageCompression from 'browser-image-compression'
import { supabase } from './supabase'

export async function uploadPhoto(file: File, folder: string): Promise<string> {
  const small = await imageCompression(file, {
    maxWidthOrHeight: 1280, initialQuality: 0.7, fileType: 'image/jpeg', useWebWorker: true,
  })
  const path = `${folder}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.jpg`
  const { error } = await supabase.storage.from('photos').upload(path, small, { contentType: 'image/jpeg', upsert: false })
  if (error) throw new Error('อัปโหลดรูปไม่สำเร็จ: ' + error.message)
  return path
}

export async function signedUrl(path: string): Promise<string | null> {
  const { data } = await supabase.storage.from('photos').createSignedUrl(path, 600)
  return data?.signedUrl ?? null
}

/** compress only (≤1280 px JPEG 0.7) — used before a photo goes into the offline queue */
export async function compressPhoto(file: File | Blob): Promise<Blob> {
  return imageCompression(file as File, { maxWidthOrHeight: 1280, initialQuality: 0.7, fileType: 'image/jpeg', useWebWorker: true })
}

/** upload to a fixed path; a retry after a half-finished attempt finds the file already there and counts it as done */
export async function uploadBlobAt(blob: Blob, path: string): Promise<string> {
  const { error } = await supabase.storage.from('photos').upload(path, blob, { contentType: 'image/jpeg', upsert: false })
  if (error && !/exist|duplicate|409/i.test(`${error.message} ${(error as { statusCode?: string }).statusCode ?? ''}`)) {
    throw new Error('อัปโหลดรูปไม่สำเร็จ: ' + error.message)
  }
  return path
}

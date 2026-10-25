const MAX_SIDE = 2000
const JPEG_QUALITY = 0.9

export async function shrinkImage(file: File): Promise<Uint8Array<ArrayBuffer>> {
	const bitmap = await createImageBitmap(file)
	const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
	if (scale === 1) {
		bitmap.close()
		return new Uint8Array(await file.arrayBuffer())
	}
	const canvas = document.createElement('canvas')
	canvas.width = Math.round(bitmap.width * scale)
	canvas.height = Math.round(bitmap.height * scale)
	canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
	bitmap.close()
	const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
	const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, type, JPEG_QUALITY))
	if (!blob) throw new Error('缩小图片失败')
	return new Uint8Array(await blob.arrayBuffer())
}
